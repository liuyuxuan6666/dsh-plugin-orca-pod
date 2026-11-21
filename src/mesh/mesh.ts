import { PodError } from "../core/errors.ts";
import { normalizePeerUrl } from "../core/net.ts";
import {
  membersDigest,
  type HelloResponse,
  type PeerView,
  SelfDescriptionSchema,
  type HelloRequest,
  type SelfDescription,
} from "./wire.ts";
import { OrcaNodeIdSchema, type OrcaNodeId } from "../core/ids.ts";
import type { BusyState } from "../task/wire.ts";
import type { MeshContext } from "./context.ts";
import { OrcaNode } from "./orca-node.ts";
import { isLoopbackUrl } from "./screening.ts";
import { heartbeatIntervalMsFor, recoverDelayMs, resolveTimings, windowsFor, type MeshTimings } from "./timings.ts";

/** A seed address that has not answered yet, and when it is tried again. */
type Seed = { fails: number; nextAtMs: number; trying: boolean };

/**
 * The node table (§3.1): every node of the workgroup is an `OrcaNode` in one map,
 * and this node is one of them. Using a node is `mesh.resolve(ref)` and then
 * calling it; what takes the whole table is done here: the directory this node
 * vouches for and its digest, the tombstones that keep a stale list from reviving
 * a forgotten node, merging a list someone else sent, the greeting loop, and
 * making first contact at an address (`probe`).
 */
export class Mesh {
  /** This node, as a row of the table like any other. */
  readonly self: OrcaNode;

  private readonly nodes = new Map<OrcaNodeId, OrcaNode>();
  private readonly tombstones = new Map<OrcaNodeId, number>();
  private readonly seeds = new Map<string, Seed>();
  private readonly current: MeshTimings;
  /** Whether the heartbeat cadence follows the size of the mesh; a pinned period keeps itself. */
  private readonly adaptive: boolean;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    private readonly ctx: MeshContext,
    /** What this node says about itself to begin with; whoever runs it pushes the changes with `self.describe`. */
    description: SelfDescription,
    options: { timings?: Partial<MeshTimings> } = {},
  ) {
    this.current = resolveTimings(options.timings);
    this.adaptive = options.timings?.intervalMs === undefined;
    this.self = OrcaNode.self(ctx, description);
    this.nodes.set(this.self.id, this.self);
  }

  // ---- the table ----

  get(id: OrcaNodeId): OrcaNode | undefined {
    return this.nodes.get(id);
  }

  /** The node, or `unknown_orca_node` for one that is not in the table. */
  require(id: OrcaNodeId): OrcaNode {
    const node = this.nodes.get(id);
    if (node === undefined) throw new PodError("unknown_orca_node", `${id} is not a member of this workgroup`);
    return node;
  }

  /** Every node of the table, this one included, by id. */
  list(): OrcaNode[] {
    return [...this.nodes.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  /** The other nodes: everyone but this one. */
  peers(): OrcaNode[] {
    return this.list().filter((node) => !node.isSelf);
  }

  /**
   * The node a person or a tool names (§3.4): its id, its display name when that
   * is unique, or an address it has: one it advertises, or one that reached it.
   * Anything else is an `unknown_peer`: only `probe` may meet a stranger.
   */
  resolve(ref: string): OrcaNode {
    const text = ref.trim();
    const id = OrcaNodeIdSchema.safeParse(text);
    const byId = id.success ? this.nodes.get(id.data) : undefined;
    if (byId !== undefined) return byId;
    const named = this.list().filter((node) => node.displayName === text);
    if (named.length === 1 && named[0] !== undefined) return named[0];
    if (named.length > 1) {
      throw new PodError(
        "bad_request",
        `${text} names several nodes; use an id: ${named.map((node) => node.id).join(", ")}`,
      );
    }
    let url: string | undefined;
    try {
      url = normalizePeerUrl(text);
    } catch {
      // Not an address either.
    }
    const byUrl = url === undefined ? undefined : this.list().find((node) => node.hasUrl(url));
    if (byUrl !== undefined) return byUrl;
    throw new PodError("unknown_peer", `${text} is not a known node, name or address; connect to it first`);
  }

  /**
   * The directory this node vouches for to others (§3.5): itself and the nodes it
   * hears from. Candidates it never reached and nodes gone quiet stay in `list()`
   * but are never passed on.
   */
  private directory(): PeerView[] {
    return this.list()
      .filter((node) => node.listed)
      .map((node) => node.view());
  }

  /** What this node passes on (§3.5); its digest is what peers compare. */
  digest(): string {
    return membersDigest(this.directory());
  }

  /** Whether a node was forgotten recently enough that a stale list must not bring it back. */
  private isTombstoned(id: OrcaNodeId): boolean {
    const until = this.tombstones.get(id);
    if (until === undefined) return false;
    if (this.ctx.clock.monotonicMs() < until) return true;
    this.tombstones.delete(id);
    return false;
  }

  /** Forget a node; its id is tombstoned so a stale remote list cannot bring it back. */
  remove(id: OrcaNodeId): void {
    if (id === this.self.id || !this.nodes.delete(id)) return;
    this.tombstones.set(id, this.ctx.clock.monotonicMs() + this.current.tombstoneMs);
  }

  /**
   * Remote lists only add records; they never touch online state.
   * `fromThisMachine`: the list arrived over loopback, so its loopback addresses are ours (§7.7).
   */
  private mergeRemote(members: readonly PeerView[], fromThisMachine: boolean): void {
    for (const member of members) {
      if (member.orca_node_id === this.self.id) continue;
      if (this.isTombstoned(member.orca_node_id)) continue;
      // A node this one may not dial is not a candidate either: it would list
      // forever without ever being contacted (§6.5).
      if (!this.ctx.trust.outboundAllows(member.orca_node_id)) continue;
      // A third-party roster is only a hint for nodes we have never met (§7.1).
      // Once a record exists, only that node's own signed self-description may
      // update its endpoints or profile; otherwise any member could redirect
      // everyone's traffic to itself.
      if (this.nodes.has(member.orca_node_id)) continue;
      this.nodes.set(member.orca_node_id, OrcaNode.candidate(this.ctx, member, fromThisMachine));
    }
  }

  /** Apply timeout transitions and prune stale records. */
  private evaluate(): void {
    const nowMs = this.ctx.clock.monotonicMs();
    for (const node of [...this.nodes.values()]) {
      node.reassess(nowMs, this.current);
      if (node.expired(nowMs, this.current)) this.remove(node.id);
    }
  }

  // ---- contact ----

  /**
   * First contact, or contact again, at an address (§3.3): the one call that may
   * reach a stranger, so only an address someone chose may come here (settings,
   * the panel, the `connect` tool). A node that is already known at the address is
   * greeted as itself, so its answer must be its own; a stranger's answer names it.
   */
  async probe(url: string): Promise<OrcaNode> {
    const known = this.list().find((node) => node.hasUrl(url));
    const answer = await OrcaNode.contact(this.ctx, url, known?.id ?? "", this.helloRequest());
    // This node's own address under another name.
    if (answer.from === this.self.id) return this.self;
    // The id is only known once it answered, so a refused node gets one hello and
    // no more: it is neither recorded nor listed (§6.5).
    if (!this.ctx.trust.outboundAllows(answer.from)) {
      throw new PodError("peer_not_permitted", `${answer.from} may not be dialed by this node`);
    }
    const self = SelfDescriptionSchema.parse(answer.body.self);
    const overLoopback = isLoopbackUrl(url);
    const endpoints = await this.screenDeclared(answer.from, self.endpoints, overLoopback);
    const node = this.admit(answer.from, { ...self, endpoints }, answer.body.self.busy, "answered");
    if (answer.body.members !== null) this.mergeRemote(answer.body.members, overLoopback);
    return node;
  }

  /**
   * Seed the mesh with the addresses this node is configured or remembers (§3.3):
   * each is contacted now, and one that does not answer is tried again on the
   * recover backoff until it does, instead of being given up at start.
   */
  async seed(urls: Iterable<string>): Promise<{ reached: OrcaNode[]; pending: string[] }> {
    const fresh: string[] = [];
    for (const url of urls) {
      if (this.self.hasUrl(url) || this.seeds.has(url)) continue;
      this.seeds.set(url, { fails: 0, nextAtMs: 0, trying: false });
      fresh.push(url);
    }
    const reached: OrcaNode[] = [];
    const pending: string[] = [];
    for (const url of fresh) {
      const node = await this.contactSeed(url);
      if (node === null) pending.push(url);
      else reached.push(node);
    }
    return { reached, pending };
  }

  /**
   * A node greeted this one (§3.3); the route has already checked the request's
   * proofs. What the sender declared about itself is still input: its endpoints
   * are screened before they are recorded (§7.7). It is recorded (or refreshed)
   * as an explicit member heard just now, and answered with this node's own
   * record and, when its digest differs, the directory.
   */
  async greeted(caller: OrcaNodeId, request: HelloRequest, overLoopback: boolean): Promise<HelloResponse> {
    if (caller !== this.self.id) {
      const endpoints = await this.screenDeclared(caller, request.self.endpoints, overLoopback);
      this.admit(caller, { ...request.self, endpoints }, request.busy, "heard");
    }
    const digest = this.digest();
    return {
      self: this.self.selfRecord(),
      members_digest: digest,
      members: request.digest === digest ? null : this.directory(),
    };
  }

  /**
   * Screen the endpoints a node declared for itself (in an inbound `hello` or in
   * the answer to our `probe`) before recording them (§7.7). A node already in the
   * table repeats the same endpoints every few seconds, so its last verdict may be
   * reused; a first contact is always screened afresh.
   */
  private async screenDeclared(id: OrcaNodeId, declared: readonly string[], overLoopback: boolean): Promise<string[]> {
    const endpoints = await this.ctx.screening.declared(declared, overLoopback, !this.nodes.has(id));
    if (endpoints.length === 0) {
      throw new PodError("endpoint_refused", `none of the declared endpoints may be dialed: ${declared.join(", ")}`);
    }
    return endpoints;
  }

  // ---- the greeting loop ----

  /** Start greeting the nodes that are due, once per interval (§3.3). */
  start(): void {
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    // ±10% jitter: senders must not stay phase-locked, and the receiver's
    // suspect window (1.25 ticks) leaves room for this spread.
    this.timer = setTimeout(() => void this.tick(), this.current.intervalMs * (0.9 + Math.random() * 0.2));
    this.timer.unref();
  }

  /**
   * One round: re-evaluate every node, greet the ones that are due and try the
   * seeds that have not answered. §3.3: the cadence follows the size of the mesh
   * (one hello per node per second) so cluster traffic stays linear.
   */
  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.adaptive) this.setIntervalMs(heartbeatIntervalMsFor(this.nodes.size));
    this.evaluate();
    const nowMs = this.ctx.clock.monotonicMs();
    // One request for the whole round: what this node says, and the digest of what it knows.
    const request = this.helloRequest();
    const greetings = [...this.nodes.values()]
      .filter((node) => node.due(nowMs))
      .map((node) => this.greet(node, request));
    const retries = [...this.seeds.entries()]
      .filter(([, seed]) => !seed.trying && seed.nextAtMs <= nowMs)
      .map(([url]) => this.contactSeed(url));
    await Promise.allSettled([...greetings, ...retries]);
    this.schedule();
  }

  /** Retarget the expected cadence, and with it the suspect, offline and timeout windows. */
  private setIntervalMs(intervalMs: number): void {
    Object.assign(this.current, windowsFor(intervalMs));
  }

  /** One hello to a node already in the table; a failure is counted once per node, not once per address. */
  private async greet(node: OrcaNode, request: HelloRequest): Promise<void> {
    const { clock } = this.ctx;
    // A node this one may not dial is not greeted at all (§6.5): no heartbeat, no
    // task, no file. It stays in the table if it was known, so the panel can show
    // why it is silent, but this node never opens a connection to it.
    if (!this.ctx.trust.outboundAllows(node.id)) return;
    try {
      const answer = await node.hello(request, this.current.heartbeatTimeoutMs);
      // Its addresses stay the ones it declared when it greeted us; an answer does not move them.
      node.answered(
        { ...SelfDescriptionSchema.parse(answer.body.self), endpoints: [...node.endpoints] },
        answer.body.self.busy,
      );
      if (answer.body.members !== null) this.mergeRemote(answer.body.members, node.answersOverLoopback);
    } catch (error) {
      if (OrcaNode.isRejection(error)) {
        // This node still uses another password: stop answering it and forget it
        // (§7.1). Its own hellos to us fail identically, so the whole old mesh
        // drops the changed node instead of keeping it "online" forever.
        this.ctx.logger.warn(`orca-pod: dropping node ${node.id} (workgroup admission rejected, §7.1)`);
        this.remove(node.id);
        return;
      }
      if (node.missed(clock.monotonicMs(), this.current) === "drop") {
        // The tombstone keeps a stale list from adding it straight back (§3.5).
        this.remove(node.id);
      }
    }
  }

  /**
   * A node spoke for itself, signed: it greeted this one (`heard`), or answered a
   * first contact (`answered`, which also shows it can be reached). Record it as
   * it described itself, heard just now. Tombstones only keep stale *remote
   * lists* from reviving a removed id; they must not lock out a node that comes
   * back on its own with a valid proof.
   */
  private admit(
    id: OrcaNodeId,
    description: SelfDescription,
    busy: BusyState | null,
    evidence: "heard" | "answered",
  ): OrcaNode {
    let node = this.nodes.get(id);
    if (node === undefined) {
      this.tombstones.delete(id);
      node = OrcaNode.explicit(this.ctx, id, description, busy);
      this.nodes.set(id, node);
    } else if (evidence === "answered") {
      node.answered(description, busy);
    } else {
      node.heard(description, busy);
    }
    return node;
  }

  /** Contact a seed address; one that does not answer waits for its turn on the backoff. Null when it did not answer. */
  private async contactSeed(url: string): Promise<OrcaNode | null> {
    const seed = this.seeds.get(url);
    if (seed === undefined) return null;
    seed.trying = true;
    try {
      const node = await this.probe(url);
      this.seeds.delete(url);
      return node;
    } catch (error) {
      seed.fails += 1;
      seed.nextAtMs = this.ctx.clock.monotonicMs() + recoverDelayMs(seed.fails, this.current);
      this.ctx.logger.warn(
        `orca-pod: contact with ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      seed.trying = false;
    }
  }

  /** What this node says in every hello: who it is, how busy, and the digest of what it knows. */
  private helloRequest(): HelloRequest {
    return { self: this.self.description, busy: this.self.view().busy, digest: this.digest() };
  }
}
