import type { FileBlobRegistry } from "../core/blobs.ts";
import type { NodeLogger } from "../core/events.ts";
import type { NodeIdentity } from "../core/identity.ts";
import type { WorkgroupId } from "../core/ids.ts";
import type { TrustPolicy } from "../core/trust.ts";
import type { DispatchLog } from "../task/dispatch-log.ts";
import type { SingleSlotTaskRunner } from "../task/runner.ts";
import { HttpPeerClient, nodeFetch, type FetchLike } from "./peer-client.ts";
import { EndpointScreen } from "./screening.ts";
import { PeerTls } from "./tls.ts";
import { resolveClock, type MeshClock } from "./timings.ts";

/** What a test may replace: the network and the clock. */
export type MeshContextOptions = {
  /** Outbound HTTP for peer calls; tests inject packet loss, delay and partitions. */
  fetch?: FetchLike;
  clock?: Partial<MeshClock>;
};

/**
 * What every node of one mesh shares (§3.1): built once by whoever assembles the
 * node and handed to each `OrcaNode` as it is made, so a node needs no further
 * collaborators to act on its own behalf. The outbound client, the endpoint
 * screen and the clock are its own; the stores it is given. One per orca
 * instance, never a global: several instances live in one process in tests and
 * while a plugin reloads.
 */
export class MeshContext {
  /** Signs and sends; it knows no node, the target is always named. */
  readonly client: HttpPeerClient;
  /** The TLS connections the client's calls go over, each pinned to the node it is addressed to (§7.7). */
  private readonly tls = new PeerTls();
  /** What this node concluded about the endpoints it was told of (§7.7). */
  readonly screening: EndpointScreen;
  readonly clock: MeshClock;

  constructor(
    /** Who this node is: its private key signs every request (§7.1). */
    readonly identity: NodeIdentity,
    readonly workgroupId: WorkgroupId,
    /** The workgroup key behind the proof of every request (§7.1). */
    key: Buffer,
    /** What this node handed to others, and what it last heard of it (§8.3). */
    readonly dispatches: DispatchLog,
    /** Files this node published (§5.6); a node that is this one serves from here. */
    readonly blobs: FileBlobRegistry,
    /** The tasks this node runs; a node that is this one reports its slot from here (§6.9). */
    readonly tasks: SingleSlotTaskRunner,
    /** Who may call this node, and which nodes it may call (§6.5). */
    readonly trust: TrustPolicy,
    readonly logger: NodeLogger,
    options: MeshContextOptions = {},
  ) {
    this.client = new HttpPeerClient(identity, key, workgroupId, options.fetch ?? nodeFetch, this.tls);
    this.screening = new EndpointScreen();
    this.clock = resolveClock(options.clock);
  }

  /** Close the connections this node holds open to others; the instance is stopping. */
  close(): Promise<void> {
    return this.tls.close();
  }
}
