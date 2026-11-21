/**
 * The trust setting (§6.5): a mesh is flat by default, and one node can make it
 * lopsided — refusing traffic from peers it does not trust, and refusing to dial
 * peers it should not reach.
 */

import { describe, expect, it } from "vitest";

import { parseTrust, TrustPolicy } from "../src/core/trust.ts";
import { WorkgroupIdSchema } from "../src/core/ids.ts";
import { parseSettings } from "../src/node/settings.ts";
import type { Orca } from "../src/node/orca.ts";
import { generateNodeIdentity } from "../src/plugin/stores.ts";
import { createGatewayHarness } from "./fixtures/gateway.ts";
import { newNode } from "./support/node.ts";
import { scriptTask } from "./support/script.ts";

const WORKGROUP = WorkgroupIdSchema.parse("orca-trust");
const PASSWORD = "trust-password-123";

/** A well-formed A2A call for a task nobody dispatched: it reaches the route, then 404s. */
const A2A_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tasks/get",
  params: { id: "01TRUSTMISSING00000000000000" },
});

const BLOB_ID = "a".repeat(64);

function node(displayName: string, trust?: unknown): Orca {
  const settings = trust === undefined ? {} : { trust: parseTrust(trust) };
  return newNode({
    workgroup_id: WORKGROUP,
    workgroup_password: PASSWORD,
    display_name: displayName,
    task_timeout_s: 60,
    // A port of its own: the default one is the real node's, and two test nodes would collide.
    port: 0,
    ...settings,
  });
}

/** Start the nodes and make sure they stop even when an assertion throws. */
async function running(nodes: Orca[], body: (urls: string[]) => Promise<void>): Promise<void> {
  try {
    const urls: string[] = [];
    for (const orca of nodes) {
      const { url } = await orca.start();
      urls.push(url);
    }
    await body(urls);
  } finally {
    await Promise.all(nodes.map((orca) => orca.stop()));
  }
}

describe("trust settings", () => {
  it("allows everything by default, so an untouched install keeps the flat mesh", () => {
    expect(parseSettings({}).trust).toEqual({ inbound: "allow", outbound: "allow", peers: {} });
  });

  it("keeps per-peer overrides, and defaults the direction it does not name", () => {
    const peer = generateNodeIdentity().orcaNodeId;
    const settings = parseSettings({ trust: { inbound: "deny", peers: { [peer]: { inbound: "allow" } } } });
    expect(settings.trust.inbound).toBe("deny");
    expect(settings.trust.outbound).toBe("allow");
    expect(settings.trust.peers[peer]).toEqual({ inbound: "allow" });
  });

  it("refuses a peer key that is not an orca node id", () => {
    expect(() => parseSettings({ trust: { peers: { "not-a-node-id": { inbound: "allow" } } } })).toThrow(/trust/);
  });
});

describe("trust policy", () => {
  const selfId = generateNodeIdentity().orcaNodeId;
  const friend = generateNodeIdentity().orcaNodeId;
  const stranger = generateNodeIdentity().orcaNodeId;

  it("applies the default to a peer without an entry, the entry to one with", () => {
    const policy = new TrustPolicy(
      parseTrust({ inbound: "deny", peers: { [friend]: { inbound: "allow", outbound: "deny" } } }),
      selfId,
    );
    expect(policy.inboundAllows(friend)).toBe(true);
    expect(policy.outboundAllows(friend)).toBe(false);
    expect(policy.inboundAllows(stranger)).toBe(false);
    expect(policy.outboundAllows(stranger)).toBe(true);
  });

  it("always lets this node through", () => {
    const policy = new TrustPolicy(parseTrust({ inbound: "deny", outbound: "deny" }), selfId);
    expect(policy.inboundAllows(selfId)).toBe(true);
    expect(policy.outboundAllows(selfId)).toBe(true);
  });

  it("reports whether anything is restricted at all", () => {
    expect(new TrustPolicy(parseTrust({}), selfId).permissive).toBe(true);
    expect(new TrustPolicy(parseTrust({ outbound: "deny" }), selfId).permissive).toBe(false);
  });
});

describe("inbound trust", () => {
  /** Sign one request as `identity` and inject it. */
  async function call(
    harness: ReturnType<typeof createGatewayHarness>,
    identity: ReturnType<typeof generateNodeIdentity>,
    method: "POST" | "GET",
    path: string,
    body?: string,
  ) {
    return harness.app.inject({
      method,
      url: path,
      headers: {
        "content-type": "application/json",
        authorization: harness.signAs(identity, method, path, body === undefined ? undefined : { body }),
      },
      payload: body,
    });
  }

  it("answers a refused peer 403 on tasks, files and greetings", async () => {
    const stranger = generateNodeIdentity();
    const harness = createGatewayHarness({ trust: { inbound: "deny" } });

    const task = await call(harness, stranger, "POST", "/a2a", A2A_BODY);
    expect(task.statusCode).toBe(403);
    expect(task.json()).toMatchObject({ error: { data: { code: "peer_blocked" } } });

    const blob = await call(harness, stranger, "GET", `/blobs/${BLOB_ID}`);
    expect(blob.statusCode).toBe(403);
    expect(blob.json()).toMatchObject({ code: "peer_blocked" });

    const hello = await harness.app.inject({
      method: "POST",
      url: "/cluster/hello",
      headers: {
        "content-type": "application/json",
        authorization: harness.signAs(stranger, "POST", "/cluster/hello", { body: "{}", target: "" }),
      },
      payload: "{}",
    });
    expect(hello.statusCode).toBe(403);
    expect(hello.json()).toMatchObject({ code: "peer_blocked" });
  });

  it("lets an allowed peer in while the default refuses everyone else", async () => {
    const friend = generateNodeIdentity();
    const stranger = generateNodeIdentity();
    const harness = createGatewayHarness({
      trust: { inbound: "deny", peers: { [friend.orcaNodeId]: { inbound: "allow" } } },
    });

    // Past the gate: the route runs and reports the task as unknown (the A2A
    // envelope carries the node's own code under `error.data`).
    const allowed = await call(harness, friend, "POST", "/a2a", A2A_BODY);
    expect(allowed.statusCode).toBe(404);
    expect(allowed.json()).toMatchObject({ error: { data: { code: "task_not_found" } } });

    const refused = await call(harness, stranger, "POST", "/a2a", A2A_BODY);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { data: { code: "peer_blocked" } } });
  });
});

describe("outbound trust", () => {
  it("refuses to dial a peer its outbound verdict blocks, while still taking that peer's tasks", async () => {
    const controller = node("controller");
    const worker = node("worker", { outbound: "deny" });

    await running([controller, worker], async () => {
      const controllerId = controller.mesh.self.id;
      const workerUrl = worker.mesh.self.endpoints[0];
      if (workerUrl === undefined) throw new Error("worker has no endpoint");

      // The controller reaches the worker: the worker's inbound verdict is open.
      await controller.mesh.probe(workerUrl);
      expect(worker.mesh.get(controllerId)).toBeDefined();

      // The worker may not call back: no task, no file, not even a heartbeat.
      const task = scriptTask({ final: { state: "completed", text: "should not run" } });
      await expect(worker.mesh.resolve(controllerId).sendTask(task)).rejects.toMatchObject({
        code: "peer_not_permitted",
      });
      await expect(worker.mesh.resolve(controllerId).fetchBlob(BLOB_ID)).rejects.toMatchObject({
        code: "peer_not_permitted",
      });

      // And the controller's own dispatch still works.
      const accepted = await controller.mesh
        .resolve(worker.mesh.self.id)
        .sendTask(scriptTask({ final: { state: "completed", text: "done" } }));
      expect(accepted.id).toBeTruthy();
    });
  });

  it("refuses a hello from a peer its inbound verdict blocks", async () => {
    const controller = node("controller");
    const stranger = node("stranger", { inbound: "deny" });

    await running([controller, stranger], async () => {
      const url = stranger.mesh.self.endpoints[0];
      if (url === undefined) throw new Error("stranger has no endpoint");
      await expect(controller.mesh.probe(url)).rejects.toMatchObject({ code: "peer_blocked" });
      expect(controller.mesh.peers()).toHaveLength(0);
    });
  });
});
