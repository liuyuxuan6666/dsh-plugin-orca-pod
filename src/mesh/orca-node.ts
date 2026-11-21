import { randomUUID } from "node:crypto";

import type { SessionId } from "@deepseek-ai/dsh-session";

import { BlobIdSchema, formatBlobRef, type OpenedBlob, type PublishedFile } from "../core/blobs.ts";
import { PodError } from "../core/errors.ts";
import {
  type ResumeControl,
  type BusyState,
  RpcResultSchema,
  permissionRequestOf,
  type A2ARequest,
  type SubmitTaskInput,
  type TaskView,
} from "../task/wire.ts";
import {
  HelloResponseSchema,
  runtimeDigest,
  type HelloResponse,
  type PeerState,
  type PeerView,
  type SelfRecord,
  SelfDescriptionSchema,
  type HelloRequest,
  type SelfDescription,
} from "./wire.ts";
import type { OrcaNodeId } from "../core/ids.ts";
import type { MeshContext } from "./context.ts";
import type { Answer } from "./peer-client.ts";
import { isLoopbackUrl } from "./screening.ts";
import { CANDIDATE_MAX_FAILURES, recoverDelayMs, type MeshTimings } from "./timings.ts";

type SuspectReason = "quiet" | "unreachable";

/** How this orca node learned about a node (§3.5, §7.7). */
type PeerOrigin = "explicit" | "candidate";

/**
 * One row of the node table (§3.1): a node of the mesh, possibly this one. It
 * holds everything this node knows about it, in one place: what it said about
 * itself, the evidence behind its state, the addresses it can be dialed at and
 * the one that last worked. Using the node is calling it: `hello`, `sendTask`,
 * `fetchBlob`. Which node is this one is a comparison of ids (`isSelf`); a node
 * that is this one is always online, is not greeted, and serves its files from
 * disk, and is otherwise the same object.
 *
 * It knows the `MeshContext`, never the `Mesh`: what needs the whole table (the
 * directory, tombstones, merging someone else's list) is the mesh's.
 */
export class OrcaNode {
  private fails = 0;
  private suspectReason: SuspectReason | null = null;
  private probeFails = 0;
  private nextProbeMs = 0;
  private offlineSinceMs: number | null = null;
  /** The address that answered last, tried first next time. */
  private preferred: string | undefined;
  /** Whether a refused candidate address was already logged; one line per node is enough. */
  private warned = false;
  /** A candidate named in a member list that arrived over loopback: its loopback addresses are this machine's (§7.7). */
  private listedFromThisMachine = false;

  private constructor(
    private readonly ctx: MeshContext,
    readonly id: OrcaNodeId,
    /** What the node last said about itself (§3.3); the rest of its record is what this node observed. */
    private described: SelfDescription,
    private observed: PeerState,
    private busy: BusyState | null,
    /** Wall time of the last signed message from it; peers see it as `last_recv_at`. */
    private lastRecvAt: string | null,
    /** Explicit: made contact or was configured directly. Candidate: only seen in a remote list. */
    private origin: PeerOrigin,
    private lastRecvMs: number | null,
  ) {}

  /** This node: online by definition, described by whoever runs it. */
  static self(ctx: MeshContext, description: SelfDescription): OrcaNode {
    return new OrcaNode(ctx, ctx.identity.orcaNodeId, description, "online", null, null, "explicit", null);
  }

  /** A node that proved itself by contact (or whose answer to ours we verified), as it described itself. */
  static explicit(ctx: MeshContext, id: OrcaNodeId, description: SelfDescription, busy: BusyState | null): OrcaNode {
    const { clock } = ctx;
    return new OrcaNode(ctx, id, description, "online", busy, clock.wallIso(), "explicit", clock.monotonicMs());
  }

  /**
   * A node only seen in somebody else's list: never reached, so `unknown`.
   * `fromThisMachine`: the list arrived over loopback, from a node on this machine.
   */
  static candidate(ctx: MeshContext, view: PeerView, fromThisMachine: boolean): OrcaNode {
    const node = new OrcaNode(
      ctx,
      view.orca_node_id,
      SelfDescriptionSchema.parse(view),
      "unknown",
      view.busy,
      null,
      "candidate",
      null,
    );
    node.listedFromThisMachine = fromThisMachine;
    return node;
  }

  /** A first contact at an address nobody vouched for: the one request every `hello` is, to a node whose id is not known yet. */
  static contact(
    ctx: MeshContext,
    endpoint: string,
    target: string,
    request: HelloRequest,
    timeoutMs?: number,
  ): Promise<Answer<HelloResponse>> {
    return ctx.client.call(
      endpoint,
      { method: "POST", path: "/cluster/hello", payload: request, reply: HelloResponseSchema },
      { target, timeoutMs },
    );
  }

  // ---- identity ----

  /** Whether this is the node this process is. */
  get isSelf(): boolean {
    return this.id === this.ctx.identity.orcaNodeId;
  }

  private get isCandidate(): boolean {
    return this.origin === "candidate";
  }

  get displayName(): string {
    return this.described.display_name;
  }

  /** This node is online from the start, and nothing it hears or misses changes that. */
  get state(): PeerState {
    return this.observed;
  }

  /** Heard, but this node cannot reach it: traffic flows one way only, as with a node behind NAT (§3.3). */
  get unreachable(): boolean {
    return this.observed === "suspect" && this.suspectReason === "unreachable";
  }

  /** Whether the address it last answered at is a loopback one: it runs on this machine. */
  get answersOverLoopback(): boolean {
    return this.preferred !== undefined && isLoopbackUrl(this.preferred);
  }

  /** Online or suspect: a node this one vouches for to others. */
  get listed(): boolean {
    return this.state === "online" || this.state === "suspect";
  }

  /** The advertised dial addresses, best first. */
  get endpoints(): readonly string[] {
    return this.described.endpoints;
  }

  /** What the node last said about itself, as a `hello` carries it. */
  get description(): SelfDescription {
    return this.described;
  }

  /** The record peers list, as this node knows it now: what it said, and what this node observed. */
  view(): PeerView {
    const { described } = this;
    const runtime = described.runtime ?? null;
    return {
      ...described,
      orca_node_id: this.id,
      endpoints: [...described.endpoints],
      runtime,
      runtime_digest: runtimeDigest(runtime),
      default_model: described.default_model ?? null,
      default_reasoning_effort: described.default_reasoning_effort ?? null,
      state: this.state,
      // This node's slot is the runner's; another node's is what it last said.
      busy: this.isSelf ? this.ctx.tasks.busy() : this.busy,
      last_recv_at: this.isSelf ? new Date().toISOString() : this.lastRecvAt,
    };
  }

  /** This node's own record with its workgroup, as it answers a `hello`; only for this node. */
  selfRecord(): SelfRecord {
    return { ...this.view(), workgroup_id: this.ctx.workgroupId };
  }

  /**
   * The node's own latest self-description replaces the recorded one, model
   * catalog included: a catalog it no longer advertises must not linger here
   * (§3.3). A node describing itself is an explicit member. For this node it is
   * what whoever runs it pushes when something changed.
   */
  describe(description: SelfDescription): void {
    this.described = { ...description, endpoints: [...description.endpoints] };
    this.origin = "explicit";
  }

  // ---- evidence ----

  /**
   * The node greeted us, signed, with what it says about itself: that replaces
   * what was recorded, and it was heard just now. It is online again, unless this
   * node cannot reach it: a node behind NAT greets us every round, yet only an
   * answer to our own hello shows it can be dialed, so until then it stays
   * `suspect(unreachable)` and is not handed tasks (§3.3).
   */
  heard(description: SelfDescription, busy: BusyState | null): void {
    if (this.isSelf) return;
    this.describe(description);
    this.busy = busy;
    this.lastRecvAt = this.ctx.clock.wallIso();
    this.lastRecvMs = this.ctx.clock.monotonicMs();
    this.probeFails = 0;
    this.nextProbeMs = 0;
    this.offlineSinceMs = null;
    if (this.suspectReason === "unreachable") return;
    this.observed = "online";
    this.suspectReason = null;
  }

  /** The node answered our request, signed: heard, and reachable, so it is online and nothing is owed. */
  answered(description: SelfDescription, busy: BusyState | null): void {
    if (this.isSelf) return;
    this.fails = 0;
    this.suspectReason = null;
    this.heard(description, busy);
  }

  /**
   * Our request to the node failed on every address. A candidate never reached is
   * given up after a few tries instead of dialing someone else's memory
   * forever (§3.5); the caller removes it and tombstones the id.
   */
  missed(nowMs: number, timings: MeshTimings): "drop" | "kept" {
    if (this.isSelf) return "kept";
    this.fails += 1;
    if (this.observed === "unknown" && this.fails >= CANDIDATE_MAX_FAILURES) return "drop";
    if (this.observed === "offline" || this.observed === "unknown") {
      this.probeFails += 1;
      this.nextProbeMs = nowMs + recoverDelayMs(this.probeFails, timings);
      return "kept";
    }
    const recentlyHeard = this.lastRecvMs !== null && nowMs - this.lastRecvMs <= timings.offlineAfterMs;
    const missThreshold = Math.max(1, Math.round(timings.suspectAfterMs / timings.intervalMs));
    if (this.fails >= missThreshold && recentlyHeard) {
      this.observed = "suspect";
      this.suspectReason = "unreachable";
    }
    return "kept";
  }

  /** Move between online, suspect and offline by how long the node has been quiet. */
  reassess(nowMs: number, timings: MeshTimings): void {
    if (this.isSelf || this.observed === "offline" || this.lastRecvMs === null) return;
    const age = nowMs - this.lastRecvMs;
    if (age >= timings.offlineAfterMs) {
      this.observed = "offline";
      this.suspectReason = null;
      this.offlineSinceMs = nowMs;
      this.nextProbeMs = nowMs;
      return;
    }
    if (age >= timings.suspectAfterMs) {
      if (this.observed === "online") {
        this.observed = "suspect";
        this.suspectReason = "quiet";
      } else if (this.suspectReason === "unreachable") {
        this.suspectReason = "quiet";
      }
      return;
    }
    // Heard again: quiet is over. Unreachable is not, until a hello of ours is answered.
    if (this.observed === "suspect" && this.suspectReason === "quiet") {
      this.observed = "online";
      this.suspectReason = null;
    }
  }

  /** A node that has been offline for the record TTL is forgotten. */
  expired(nowMs: number, timings: MeshTimings): boolean {
    return (
      this.observed === "offline" && this.offlineSinceMs !== null && nowMs - this.offlineSinceMs >= timings.recordTtlMs
    );
  }

  /** Whether a hello is due: offline nodes and unreached candidates are probed on the backoff schedule; this node never. */
  due(nowMs: number): boolean {
    if (this.isSelf || this.described.endpoints.length === 0) return false;
    if (this.observed !== "offline" && this.observed !== "unknown") return true;
    return nowMs >= this.nextProbeMs;
  }

  // ---- addresses ----

  /** Whether `url` is an address this node advertises; one it was reached at but does not advertise is not. */
  hasUrl(url: string): boolean {
    const key = OrcaNode.trimSlash(url);
    return this.described.endpoints.some((own) => OrcaNode.trimSlash(own) === key);
  }

  /** Addresses this node can be dialed at: screened if it came from a remote list, the last good one first. */
  private async dialOrder(): Promise<string[]> {
    const allowed: string[] = [];
    for (const endpoint of this.described.endpoints) {
      if (!this.isCandidate || (await this.candidateAllowed(endpoint))) allowed.push(endpoint);
    }
    const { preferred } = this;
    return preferred !== undefined && allowed.includes(preferred)
      ? [preferred, ...allowed.filter((endpoint) => endpoint !== preferred)]
      : allowed;
  }

  /** An address from another node's member list is screened before it is dialed (§7.7). */
  private async candidateAllowed(endpoint: string): Promise<boolean> {
    const allowed = await this.ctx.screening.candidate(endpoint, this.listedFromThisMachine);
    if (!allowed && !this.warned) {
      this.warned = true;
      this.ctx.logger.warn(`orca-pod: refusing candidate endpoint ${endpoint} from ${this.id} (§7.7)`);
    }
    return allowed;
  }

  // ---- calls ----

  /**
   * Refuse a call this node's settings do not permit (§6.5). The check sits before
   * the first packet, not in the peer: a refused node never learns it was called.
   */
  private assertOutbound(): void {
    if (!this.ctx.trust.outboundAllows(this.id)) {
      throw new PodError("peer_not_permitted", `${this.id} may not be dialed by this node`);
    }
  }

  /**
   * Greet the node (§3.3): try its addresses in order (IPv4/IPv6, LAN, public),
   * because one unreachable address must not make the node look offline (§7.7).
   * The one that answers is remembered. A node that answers with a refusal has
   * answered for all of its addresses, so that ends the attempt; one that does not
   * answer at any address is an error for the caller to count.
   */
  hello(request: HelloRequest, timeoutMs?: number): Promise<Answer<HelloResponse>> {
    return this.dial(
      (endpoint) => OrcaNode.contact(this.ctx, endpoint, this.id, request, timeoutMs),
      // Every address belongs to the same node, so a credential mismatch is final.
      (error) => OrcaNode.isRejection(error),
    );
  }

  /**
   * Try the node's addresses in order until one answers; that one is tried first
   * next time. `final` names the failures that end the attempt, because the node
   * answered for all of its addresses; any other moves on to the next address.
   */
  private async dial<T>(attempt: (endpoint: string) => Promise<T>, final: (error: unknown) => boolean): Promise<T> {
    this.assertOutbound();
    let unreachable: unknown;
    for (const endpoint of await this.dialOrder()) {
      try {
        const result = await attempt(endpoint);
        this.preferred = endpoint;
        return result;
      } catch (error) {
        if (final(error)) throw error;
        unreachable = error;
      }
    }
    throw unreachable ?? new PodError("peer_not_online", `${this.id} has no address to dial`);
  }

  /** Whether an error is the node saying it no longer shares this node's password (§7.1). */
  static isRejection(error: unknown): boolean {
    return error instanceof PodError && error.status === 401;
  }

  /**
   * Hand this node a task. A node that is not online is not handed one. `agentId`
   * is the DSH session that dispatches it; it goes into the dispatch log with the
   * entry, so the tracker knows whom to tell when the task ends (§8.3).
   */
  async sendTask(
    input: SubmitTaskInput,
    options: { signal?: AbortSignal; agentId?: SessionId } = {},
  ): Promise<TaskView> {
    // Before the state, so a refused node reports the rule and not "offline".
    this.assertOutbound();
    const { state } = this;
    if (state !== "online") throw new PodError("peer_not_online", `peer ${this.id} is ${state}`);
    const view = await this.rpc({ method: "message/send", params: input }, options.signal);
    this.ctx.dispatches.recordSend(this.id, view, options.agentId);
    return view;
  }

  getTask(taskId: string, signal?: AbortSignal): Promise<TaskView> {
    return this.rpc({ method: "tasks/get", params: { id: taskId } }, signal);
  }

  cancelTask(taskId: string, signal?: AbortSignal): Promise<TaskView> {
    return this.rpc({ method: "tasks/cancel", params: { id: taskId } }, signal);
  }

  /** This node is the origin: approve the request the task is parked on and resume it (§7.11). */
  approve(view: TaskView): Promise<TaskView> {
    const request = permissionRequestOf(view);
    if (request === null) throw new Error("task is not waiting for a permission decision");
    return this.resume(view, { permission_granted: true, request_id: request.request_id });
  }

  deny(view: TaskView, reason: string): Promise<TaskView> {
    return this.resume(view, { permission_denied: true, reason });
  }

  /**
   * A file this node published, streamed (§5.6): this node's own from disk, any
   * other node's fetched from the first of its addresses that answers. A file is
   * named by who published it and its sha256, never by a URL; the caller checks
   * the bytes against the sha256.
   */
  async fetchBlob(blobId: string, signal?: AbortSignal): Promise<OpenedBlob> {
    if (!BlobIdSchema.safeParse(blobId).success)
      throw new PodError("bad_request", "a blob id is a lowercase sha256 hex digest");
    if (this.isSelf) return this.ctx.blobs.open(blobId);
    return this.dial(
      (endpoint) => this.ctx.client.download(endpoint, blobId, { target: this.id, signal }),
      // The node answered, or the caller gave up: that stands.
      (error) => OrcaNode.isAnswer(error) || signal?.aborted === true,
    );
  }

  /**
   * Publish a file of this machine (§5.6): the registry copies it in, and its
   * name is this node's id and the sha256 of its bytes. Only this node publishes.
   */
  async publish(path: string, ttlS?: number): Promise<PublishedFile> {
    if (!this.isSelf) throw new Error(`${this.id} is another node; only this node publishes files`);
    const blob = await this.ctx.blobs.register(path, ttlS);
    return {
      ref: formatBlobRef({ node: this.id, blob_id: blob.blob_id }),
      size: blob.size,
      expires_at: blob.expires_at,
    };
  }

  /** Answer a suspended task with an approval or a denial: one data part, addressed by task id. */
  private resume(view: TaskView, control: ResumeControl): Promise<TaskView> {
    const parts = [{ kind: "data" as const, data: { ...control } }];
    return this.rpc({
      method: "message/send",
      params: { message: { role: "user", parts, taskId: view.id, messageId: randomUUID() } },
    });
  }

  /**
   * Signed JSON-RPC call to the node's `/a2a` (§4.7); every method answers with a
   * task view; an answer that is not one is a `peer_error`. Its addresses are tried in
   * order until one answers.
   */
  private async rpc(request: A2ARequest, signal?: AbortSignal): Promise<TaskView> {
    const { method } = request;
    const { body } = await this.dial(
      (endpoint) =>
        this.ctx.client.call(
          endpoint,
          {
            method: "POST",
            path: "/a2a",
            label: method,
            payload: { jsonrpc: "2.0", id: randomUUID(), ...request },
            reply: RpcResultSchema,
          },
          { target: this.id, signal },
        ),
      // The node answered, or the caller gave up: that stands.
      (error) => OrcaNode.isAnswer(error) || signal?.aborted === true,
    );
    return body.result;
  }

  /** Whether an error is the node's own answer; a deadline that ran out is not (by name, not instanceof: errors may cross realms). */
  private static isAnswer(error: unknown): boolean {
    return error instanceof Error && error.name === "PodError" && (error as PodError).code !== "peer_timeout";
  }

  private static trimSlash(url: string): string {
    return url.replace(/\/+$/, "");
  }
}
