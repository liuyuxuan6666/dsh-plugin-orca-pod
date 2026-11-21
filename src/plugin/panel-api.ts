/**
 * What the Orca panel and its host half say to each other over `/orca-api`
 * (§9.2), in one place: request bodies as schemas the host parses, response
 * shapes as types the client imports (type-only, so they are erased from the
 * bundle). `panel.ts` fills the shapes, `panel-routes.ts` serves them.
 */

import type { LlmReasoningEffortInfo } from "@deepseek-ai/dsh-llm";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { z } from "zod";

import type { Verdict } from "../core/trust.ts";
import type { PeerView } from "../mesh/wire.ts";
import type { PanelPatch, Settings } from "../node/settings.ts";
import type { DispatchEntry, TaskState, TaskView } from "../task/wire.ts";

/**
 * A node as the panel shows it; `busy_from` is the label of the origin it is busy
 * for. `unreachable`: this node hears it but cannot connect to it, so traffic
 * flows one way only (§3.3); this node's own observation, not part of the wire view.
 */
export type PodPeer = PeerView & {
  busy_from: string | null;
  unreachable: boolean;
  /** What this node accepts from the peer (§6.5): `deny` answers it `403 peer_blocked`. */
  inbound: Verdict;
  /** Whether this node may dial the peer (§6.5): `deny` never opens a connection to it. */
  outbound: Verdict;
};

/** One permission request waiting for the human. */
export interface PodApproval {
  /** `node|task_id`: stable across polls. */
  id: string;
  /** The node the task runs on: what the panel posts back to approve or deny. */
  peer: string;
  task_id: string;
  tool: string;
  /** Short preview of the requested arguments. */
  requested: string;
  /** Label of the node that needs the permission. */
  from: string;
  /** The task's mode now, and the mode it asks to continue with until it ends. */
  current_mode: SandboxMode;
  requested_mode: SandboxMode;
  /** DSH session that dispatched the task; null for a send without one. */
  agent_id: string | null;
}

/** One row of the task tables: a task this node runs, or one it dispatched. */
export interface PodTaskRow {
  id: string;
  /** The node the task runs on, which details and cancel address: this node for local tasks, the target for dispatched ones. */
  peer: string;
  state: TaskState | "unknown";
  /** Origin of a local task, target of a dispatched one, as a display label. */
  who: string;
  who_title: string;
  at: string;
  cancellable: boolean;
}

/** Everything the task detail dialog shows. */
export interface PodTaskDetail {
  task: TaskView;
  origin: string;
  dispatch: DispatchEntry | null;
}

/** The pod's configuration as the panel sees it: the settings, and what the running node made of them. */
export interface PodConfigView {
  /** True once a workgroup and its stored password exist (first-run setup done). */
  configured: boolean;
  /**
   * The settings as the last start read them; an absent field takes its default.
   * They never hold the password, and the ACP executor's are left out: the env of
   * its MCP servers may hold secrets, and the panel does not edit them.
   */
  settings: Omit<Settings, "acp">;
  /** The port the node listens on while it runs, else the setting. */
  port: number;
  /** Dial URLs the form starts from: the usable advertised ones, else this machine's detected addresses. */
  suggested_endpoints: string[];
  /** The permission modes this DSH accepts, in rank order (read from DSH itself). */
  permission_modes: readonly SandboxMode[];
  /** The efforts the host's default model offers, least to most (read from DSH's `llm`). */
  reasoning_efforts: readonly LlmReasoningEffortInfo[];
  /** Listen addresses the form offers. */
  bind_choices: string[];
  error: string | null;
}

/** Panel state snapshot: everything the status page and the approval cards render in one poll. */
export interface PodState {
  /** This node's own record while it runs; null while it does not. */
  self: PodPeer | null;
  config: PodConfigView;
  /** Reachable members only: offline records are dropped. */
  members: PodPeer[];
  approvals: PodApproval[];
  recent: PodTaskRow[];
  /** The workgroup root tasks run in, while the node runs. */
  workspace_root: string | null;
}

const Text = z.string().min(1, "must be a non-empty string");

/** `approve`, `cancel`: one task on one peer. */
export const PeerTaskBodySchema = z.object({ peer: Text, task_id: Text });
type PeerTaskBody = z.infer<typeof PeerTaskBodySchema>;

/** `deny`: the same, and why. A reason that is not text is dropped, not an error. */
export const DenyBodySchema = PeerTaskBodySchema.extend({ reason: z.string().optional().catch(undefined) });
type DenyBody = z.infer<typeof DenyBodySchema>;

/** `connect`: the peer address to join. */
export const ConnectBodySchema = z.object({ peer: Text });
type ConnectBody = z.infer<typeof ConnectBodySchema>;

/** What each POST action of the panel takes (`reset` reads no body); every one answers `{}` once it is done. */
export type PodActions = {
  config: PanelPatch;
  connect: ConnectBody;
  reset: Record<string, never>;
  approve: PeerTaskBody;
  deny: DenyBody;
  cancel: PeerTaskBody;
};

/** The GET routes: the query string each reads and the body it answers with. */
export type PodReads = {
  state: { query: Record<string, never>; response: PodState };
  /** Every task this node knows about, for the "all tasks" view (the newest `TASKS_LIMIT`). */
  tasks: { query: Record<string, never>; response: PodTaskRow[] };
  task: { query: { peer: string; task: string }; response: PodTaskDetail };
};
