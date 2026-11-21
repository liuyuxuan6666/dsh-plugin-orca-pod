/**
 * Who may call this node, and which nodes this one may call (§6.5).
 *
 * A mesh is flat: every member may dispatch to every member, read its tasks and
 * fetch its files. That is the right default for machines one owns, and the
 * wrong one for a controller that runs jobs on a box it does not want reaching
 * back. This setting makes the direction asymmetric on purpose:
 *
 * - `inbound` decides the traffic this node accepts: `hello`, `/a2a` and blob
 *   downloads from a peer it refuses are answered `403 peer_blocked`.
 * - `outbound` decides the traffic this node starts: a refused peer is never
 *   dialed — no heartbeat, no task, no file — and every call fails locally with
 *   `403 peer_not_permitted` before a packet leaves the machine.
 *
 * Both carry a default and per-peer overrides, so "I may call you, you may not
 * call me" is one configuration and not a new protocol. The settings are read
 * once when the node starts, like every other node setting: a change takes the
 * panel's save-and-restart.
 */

import { z } from "zod";

import { OrcaNodeIdSchema, type OrcaNodeId } from "./ids.ts";

/** What this node decided about one direction: `allow` lets the peer through, `deny` refuses it. */
export const VerdictSchema = z.enum(["allow", "deny"]);
export type Verdict = z.infer<typeof VerdictSchema>;

/** One peer's overrides; a direction left out follows the default. */
const PeerVerdictsSchema = z.object({
  inbound: VerdictSchema.optional(),
  outbound: VerdictSchema.optional(),
});
export type PeerVerdicts = z.output<typeof PeerVerdictsSchema>;

/**
 * Per-peer overrides keyed by orca node id (the base58 public key). A key that
 * is not an id would never match a peer, so it is refused at parse time instead
 * of sitting in the file forever.
 */
const PeersSchema = z.record(z.string(), PeerVerdictsSchema).superRefine((peers, ctx) => {
  for (const key of Object.keys(peers)) {
    if (!OrcaNodeIdSchema.safeParse(key).success) {
      ctx.addIssue({ code: "custom", path: [key], message: "must be an orca node id" });
    }
  }
});

/** The defaults an unset field takes: a fresh install trusts everyone, as 0.1.x did. */
export const TrustSettingsSchema = z.object({
  inbound: VerdictSchema.default("allow"),
  outbound: VerdictSchema.default("allow"),
  peers: PeersSchema.default({}),
});
export type TrustSettings = z.output<typeof TrustSettingsSchema>;

/** Read `trust` out of an untrusted value, with every field defaulted. */
export function parseTrust(input: unknown): TrustSettings {
  return TrustSettingsSchema.parse(input ?? {});
}

/**
 * The decisions a running node makes about one peer at a time. Built once from
 * the settings when the node starts; the settings themselves stay where they are
 * (the settings file), so this class never writes anything.
 */
export class TrustPolicy {
  constructor(
    private readonly settings: TrustSettings,
    /** This node: it always reaches and serves itself, whatever the settings say. */
    private readonly selfId: OrcaNodeId,
  ) {}

  /** Whether `id` may call this node (dispatch a task, read one, download a file, or greet it). */
  inboundAllows(id: string): boolean {
    return this.allows("inbound", id);
  }

  /** Whether this node may call `id`. A refused peer is never dialed. */
  outboundAllows(id: string): boolean {
    return this.allows("outbound", id);
  }

  /** What the panel shows for one member: the verdicts that actually apply. */
  verdictsFor(id: string): { inbound: Verdict; outbound: Verdict } {
    return { inbound: this.verdictFor("inbound", id), outbound: this.verdictFor("outbound", id) };
  }

  /** True when nothing is restricted in either direction (the behaviour of a fresh install). */
  get permissive(): boolean {
    return (
      this.settings.inbound === "allow" &&
      this.settings.outbound === "allow" &&
      Object.keys(this.settings.peers).length === 0
    );
  }

  private allows(direction: "inbound" | "outbound", id: string): boolean {
    return this.verdictFor(direction, id) === "allow";
  }

  private verdictFor(direction: "inbound" | "outbound", id: string): Verdict {
    if (id === this.selfId) return "allow";
    return this.settings.peers[id]?.[direction] ?? this.settings[direction];
  }
}
