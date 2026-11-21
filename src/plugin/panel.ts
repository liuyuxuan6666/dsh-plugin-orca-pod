/**
 * The model behind the UI panel (§9.2): what it shows and what it can do.
 *
 * The panel renders members, tasks, pending approvals and the workspace root.
 * Everything here is a projection over the pod's running node and the approval
 * broker, already resolved for display (names, labels, what can be cancelled):
 * the client holds no business logic. The shapes it
 * answers with are the contract in `panel-api.ts`. Permission
 * decisions bypass the model on purpose, because the human is sitting at this
 * node (see §7.12) and should not need a tool round-trip.
 */

import { SANDBOX_MODES } from "@deepseek-ai/dsh-sandbox-policy";
import { type DispatchEntry, type PodTaskMetadata, type TaskView, isTerminal } from "../task/wire.ts";
import { shortenNodeId } from "../core/identity.ts";
import { detectLocalEndpoints, type Orca } from "../node/orca.ts";
import { isLoopbackEndpoint, type Pod } from "./pod.ts";
import type { OrcaNode } from "../mesh/orca-node.ts";
import type { PeerView } from "../mesh/wire.ts";
import type { ModelCatalogFeed } from "./catalog.ts";
import { taskKey, type Tracker } from "./tracker.ts";
import type { PodConfigView, PodPeer, PodState, PodTaskDetail, PodTaskRow } from "./panel-api.ts";

const REQUESTED_PREVIEW_CHARS = 160;

/** Rows of the status page's recent-tasks table. */
const RECENT_LIMIT = 5;

/** Display names for node ids and endpoint URLs, resolved against one roster snapshot. */
class RosterLabels {
  private readonly peers: PeerView[];

  constructor(orca: Orca | null) {
    this.peers = orca === null ? [] : orca.mesh.list().map((node) => node.view());
  }

  label(key: string | undefined): string {
    if (key === undefined || key.length === 0) return "-";
    const known = this.peers.find((peer) => peer.orca_node_id === key || peer.endpoints.includes(key));
    if (known !== undefined) return known.display_name;
    return URL.canParse(key) ? new URL(key).host : shortenNodeId(key);
  }
}

/**
 * What the UI panel shows and does, over one pod (its running node) and the
 * approval broker.
 */
export class PanelModel {
  constructor(
    private readonly pod: Pod,
    /** Holds the permission requests waiting for the user. */
    private readonly tracker: Tracker,
    /** The host's model catalog; without one the panel offers no effort to pick. */
    private readonly catalog: ModelCatalogFeed,
  ) {}

  /** Local tasks and dispatched tasks merged, newest first. */
  recent(limit: number): PodTaskRow[] {
    const current = this.pod.run;
    return current === null ? [] : PanelModel.recentOf(current, new RosterLabels(current), limit);
  }

  /**
   * Everything the status page and the approval cards render, in one poll. The run
   * is read once, so every part describes the same node even if a restart is queued
   * meanwhile.
   */
  async state(): Promise<PodState> {
    const current = this.pod.run;
    const labels = new RosterLabels(current);
    const shown = (node: OrcaNode): PodPeer => {
      const view = node.view();
      return {
        ...view,
        busy_from: view.busy === null ? null : labels.label(view.busy.origin_orca_node),
        unreachable: node.unreachable,
        // The verdicts that apply, so the panel can show why a node is silent (§6.5).
        ...(current === null
          ? { inbound: "allow" as const, outbound: "allow" as const }
          : current.trust.verdictsFor(node.id)),
      };
    };
    return {
      self: current === null ? null : shown(current.mesh.self),
      config: await this.config(current),
      members:
        current === null
          ? []
          : current.mesh
              .peers()
              .filter((node) => node.state !== "offline")
              .map(shown),
      approvals: this.tracker.approvals().map(({ node, view, request, agentId }) => ({
        id: taskKey(node, view.id),
        peer: node,
        task_id: view.id,
        tool: request.tool,
        requested: PanelModel.preview(request.requested),
        from: labels.label(request.requested_by),
        current_mode: request.current_mode,
        requested_mode: request.requested_mode,
        agent_id: agentId,
      })),
      recent: current === null ? [] : PanelModel.recentOf(current, labels, RECENT_LIMIT),
      workspace_root: current?.workspace.root ?? null,
    };
  }

  async task(ref: string, taskId: string): Promise<PodTaskDetail> {
    const current = await this.pod.orca();
    const node = current.mesh.resolve(ref);
    const task = await node.getTask(taskId);
    return {
      task,
      origin: new RosterLabels(current).label(PanelModel.podOf(task).origin_orca_node),
      dispatch: current.dispatches.list().find((entry) => entry.task_id === task.id) ?? null,
    };
  }

  /** Effective config plus setup state, for the node `current` (null: none runs); the password itself is never returned. */
  async config(current: Orca | null = this.pod.run): Promise<PodConfigView> {
    const { pod } = this;
    const { acp: _acp, ...settings } = pod.settings;
    const { status } = pod;
    const port = current?.port ?? settings.port;
    const usable = (current?.mesh.self.endpoints ?? settings.endpoints).filter((url) => !isLoopbackEndpoint(url));
    return {
      configured: pod.configured,
      settings,
      port,
      suggested_endpoints: usable.length > 0 ? usable : detectLocalEndpoints(port),
      permission_modes: SANDBOX_MODES,
      reasoning_efforts: this.catalog.current().reasoningEfforts,
      bind_choices: [...new Set([...PanelModel.bindChoices(port), settings.bind_host])],
      error: status.kind === "failed" ? status.error.message : null,
    };
  }

  /** Listen-address choices for setup UIs: loopback, every interface, then each detected local address. */
  private static bindChoices(port: number): string[] {
    const hosts = detectLocalEndpoints(port).map((url) => new URL(url).hostname.replace(/^\[|\]$/g, ""));
    return [...new Set(["127.0.0.1", "::", ...hosts])];
  }

  private static podOf(view: TaskView): PodTaskMetadata {
    return view.metadata?.pod ?? {};
  }

  private static isActive(state: string): boolean {
    return state !== "unknown" && !isTerminal(state);
  }

  private static preview(value: unknown): string {
    const text = JSON.stringify(value) ?? "";
    return text.length > REQUESTED_PREVIEW_CHARS ? `${text.slice(0, REQUESTED_PREVIEW_CHARS - 1)}…` : text;
  }

  /** The newest `limit` tasks this node runs and dispatched, merged, newest first. */
  private static recentOf(current: Orca, labels: RosterLabels, limit: number): PodTaskRow[] {
    const tasks = current.tasks.list(limit);
    const local = new Set(tasks.map((view) => view.id));
    const rows: PodTaskRow[] = [
      ...tasks.map((view) => PanelModel.localRow(current, labels, view)),
      ...current.dispatches
        .list()
        .slice(-limit)
        .filter((entry) => !local.has(entry.task_id))
        .map((entry) => PanelModel.dispatchRow(labels, entry)),
    ];
    return rows.sort((left, right) => right.at.localeCompare(left.at)).slice(0, limit);
  }

  /** A task this node dispatched: its who is the target. */
  private static dispatchRow(labels: RosterLabels, entry: DispatchEntry): PodTaskRow {
    return {
      id: entry.task_id,
      peer: entry.node,
      state: entry.state,
      who: labels.label(entry.node),
      who_title: entry.node,
      at: entry.updated_at,
      cancellable: PanelModel.isActive(entry.state),
    };
  }

  /** A task this node runs: its who is the node that dispatched it. */
  private static localRow(current: Orca, labels: RosterLabels, view: TaskView): PodTaskRow {
    const origin = PanelModel.podOf(view).origin_orca_node;
    return {
      id: view.id,
      peer: current.mesh.self.id,
      state: view.status.state,
      who: labels.label(origin),
      who_title: origin ?? "",
      at: view.status.timestamp,
      cancellable: PanelModel.isActive(view.status.state),
    };
  }
}
