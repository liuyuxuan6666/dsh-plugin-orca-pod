import { randomBytes } from "node:crypto";

import { afterEach, vi } from "vitest";

import { FileBlobRegistry } from "../../src/core/blobs.ts";
import { parseSettings } from "../../src/node/settings.ts";
import { parseTrust, TrustPolicy } from "../../src/core/trust.ts";
import type { OrcaNodeId, WorkgroupId } from "../../src/core/ids.ts";
import type { PeerView } from "../../src/mesh/wire.ts";
import { Gateway } from "../../src/api/gateway.ts";
import { MeshContext } from "../../src/mesh/context.ts";
import { Mesh } from "../../src/mesh/mesh.ts";
import type { FetchLike } from "../../src/mesh/peer-client.ts";
import { resolveClock, type MeshTimings } from "../../src/mesh/timings.ts";
import { DispatchLog } from "../../src/task/dispatch-log.ts";
import { wg } from "../fixtures/ids.ts";
import { createTestRunner, openDb, tempDir } from "../fixtures/runner.ts";
import { generateNodeIdentity } from "../../src/plugin/stores.ts";

/** One node of a `TestNet`: a real mesh behind its real gateway, reachable at `url`. */
export type NetNode = {
  id: OrcaNodeId;
  url: string;
  mesh: Mesh;
  gateway: Gateway;
};

/** Statuses a `Response` may not carry a body with. */
const NULL_BODY = new Set([101, 204, 205, 304]);

/** How far `advance` moves the clock before it lets the calls in flight finish. */
const STEP_MS = 10;

/** Nets of the running test; their meshes are stopped after it. */
const nets: TestNet[] = [];

afterEach(async () => {
  for (const net of nets.splice(0)) await net.close();
  vi.useRealTimers();
});

/**
 * An in-process workgroup for the table's rules (§3): every node is a real mesh
 * behind its real gateway, and a node's outbound call is handed to the gateway
 * at the address it dials (Fastify's `inject`), so nothing listens on a socket.
 * Time is the fake timers': the meshes' clocks read the faked `Date`, and the
 * test moves it with `advance`. The test decides which calls get through
 * (`cut`, `heal`, `down`); one that does not fails the way an unreachable
 * address does.
 */
export class TestNet {
  /** Every outbound call, in order: who dialed which URL, and when. */
  readonly dials: Array<{ from: OrcaNodeId; url: string; at: number }> = [];
  private readonly byOrigin = new Map<string, NetNode>();
  private readonly blocked = new Set<string>();
  private readonly dead = new Set<OrcaNodeId>();
  private readonly workgroup: WorkgroupId = wg("mesh-test");
  private readonly key = randomBytes(32);
  private readonly clock = resolveClock({ monotonicMs: () => Date.now(), wallIso: () => new Date().toISOString() });
  private hosts = 0;
  private inFlight = 0;

  constructor(private readonly timings: Partial<MeshTimings> = {}) {
    // Fastify answers an `inject` over `setImmediate`, which keeps running for real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    nets.push(this);
  }

  /**
   * A node that has not started its loop yet. Its address is `https://10.0.0.<n>:11811`
   * unless `endpoints` says otherwise; only the first one is routed to it.
   */
  node(options: { endpoints?: string[]; timings?: Partial<MeshTimings> } = {}): NetNode {
    this.hosts += 1;
    const endpoints = options.endpoints ?? [`https://10.0.0.${this.hosts}:11811`];
    const identity = generateNodeIdentity();
    const db = openDb();
    const blobs = new FileBlobRegistry(db, tempDir("orca-blobs-"));
    const tasks = createTestRunner();
    const trust = new TrustPolicy(parseTrust({}), identity.orcaNodeId);
    const context = new MeshContext(
      identity,
      this.workgroup,
      this.key,
      new DispatchLog(db),
      blobs,
      tasks,
      trust,
      { warn() {} },
      { fetch: this.fetchFrom(identity.orcaNodeId), clock: this.clock },
    );
    const mesh = new Mesh(
      context,
      { display_name: `node-${this.hosts}`, endpoints, max_task_ttl_s: parseSettings({}).task_timeout_s },
      { timings: { ...this.timings, ...options.timings } },
    );
    const gateway = new Gateway(
      mesh,
      tasks,
      this.workgroup,
      this.key,
      identity,
      randomBytes(16).toString("base64url"),
      tempDir("orca-workspace-"),
      trust,
    );
    const [url] = endpoints;
    if (url === undefined) throw new Error("a net node needs an address");
    const node: NetNode = { id: identity.orcaNodeId, url, mesh, gateway };
    this.byOrigin.set(new URL(url).origin, node);
    return node;
  }

  /** Nodes that have started their loops, each knowing the one before it (its first `probe`). */
  async started(count: number): Promise<NetNode[]> {
    const nodes = Array.from({ length: count }, () => this.node());
    for (const [index, node] of nodes.entries()) {
      node.mesh.start();
      const previous = nodes[index - 1];
      if (previous !== undefined) await node.mesh.probe(previous.url);
    }
    return nodes;
  }

  /**
   * Move the clock and run every timer that falls due, with what they start. Time
   * moves in small steps, and each step waits for the calls in flight to be
   * answered, so a round of greetings finishes at the moment it started, as it
   * nearly does on a real network.
   */
  async advance(ms: number): Promise<void> {
    for (let left = ms; left > 0; left -= STEP_MS) {
      await vi.advanceTimersByTimeAsync(Math.min(STEP_MS, left));
      await this.settle();
    }
  }

  /** Wait until no call is in flight, and for what its answer starts. */
  async settle(): Promise<void> {
    do await new Promise((resolve) => setImmediate(resolve));
    while (this.inFlight > 0);
    await new Promise((resolve) => setImmediate(resolve));
  }

  /** Calls from `from` to `to` fail from now on; both ways unless `oneWay`. */
  cut(from: NetNode, to: NetNode, oneWay = false): void {
    this.blocked.add(`${from.id}>${to.id}`);
    if (!oneWay) this.blocked.add(`${to.id}>${from.id}`);
  }

  heal(from: NetNode, to: NetNode): void {
    this.blocked.delete(`${from.id}>${to.id}`);
    this.blocked.delete(`${to.id}>${from.id}`);
  }

  /** The node dies: its loop stops and nothing reaches it. */
  down(node: NetNode): void {
    node.mesh.stop();
    this.dead.add(node.id);
  }

  /** How many calls `from` made to `to`. */
  dialsTo(from: NetNode, to: NetNode): number {
    return this.dialTimes(from, to).length;
  }

  /** When `from` called `to`, in order. */
  dialTimes(from: NetNode, to: NetNode): number[] {
    return this.dials.filter((dial) => dial.from === from.id && dial.url.startsWith(to.url)).map((dial) => dial.at);
  }

  async close(): Promise<void> {
    for (const node of this.byOrigin.values()) {
      node.mesh.stop();
      await node.gateway.close();
    }
  }

  private fetchFrom(from: OrcaNodeId): FetchLike {
    return async (url, init) => {
      this.dials.push({ from, url: url.href, at: Date.now() });
      const target = this.byOrigin.get(url.origin);
      if (
        target === undefined ||
        this.dead.has(target.id) ||
        this.dead.has(from) ||
        this.blocked.has(`${from}>${target.id}`)
      ) {
        throw new TypeError("fetch failed");
      }
      this.inFlight += 1;
      const reply = await target.gateway.app
        .inject({
          method: init.method as "POST",
          url: `${url.pathname}${url.search}`,
          headers: init.headers as Record<string, string>,
          payload: init.body as string | undefined,
        })
        .finally(() => {
          this.inFlight -= 1;
        });
      const headers = new Headers();
      for (const [name, value] of Object.entries(reply.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
      }
      return new Response(NULL_BODY.has(reply.statusCode) ? null : reply.rawPayload, {
        status: reply.statusCode,
        headers,
      });
    };
  }
}

/** A record as a remote list carries it. */
export function listed(
  id: OrcaNodeId,
  endpoint = "http://127.0.0.1:11811",
  overrides: Partial<PeerView> = {},
): PeerView {
  return {
    orca_node_id: id,
    display_name: `node-${id}`,
    endpoints: [endpoint],
    runtime: null,
    runtime_digest: `digest-${id}`,
    state: "online",
    busy: null,
    last_recv_at: null,
    ...overrides,
  };
}
