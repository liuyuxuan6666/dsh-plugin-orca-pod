/** The panel: status page, first-run wizard or settings, the sidebar entry and the overlay dialog. */

import {
  Button,
  IconChevronRightOutlineRegular,
  IconSettingsOutlineRegular,
  IconWarningOutlineRegular,
  Input,
  Modal,
  StateDot,
  Tag,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import React, { type ReactNode } from "react";
import { ApprovalList } from "./approvals.tsx";
import { short } from "./format.ts";
import { DEFAULT_PORT } from "../core/constants.ts";
import { t, useLocale } from "./i18n.ts";
import { Members, NodeDetail, Workspace } from "./members.tsx";
import css from "./panel.module.css";
import { Empty, Section, Updated } from "./primitives.tsx";
import { ConfigForm, type Frame } from "./settings.tsx";
import { type Snapshot, store, useStore } from "./store.ts";
import { AllTasks, TaskDetail, TaskTable } from "./tasks.tsx";
import type { PodPeer, PodState, PodTaskRow } from "./types.ts";
import ui from "./ui.module.css";

/** The card that joins a peer by address, shown until this node is in a mesh. */
function ConnectCard({ busy }: { busy: boolean }) {
  const [host, setHost] = React.useState("");
  async function connect(event: React.FormEvent) {
    event.preventDefault();
    if (await store.act("connect", { peer: host.trim() })) setHost("");
  }
  return (
    <form className={`${ui.card} ${css.connect}`} onSubmit={connect}>
      <div className={css.connectText}>
        <h3 className={ui.cardTitle}>{t("connectPeer")}</h3>
        <span className={ui.caption}>{t("notJoined").replace("{port}", String(DEFAULT_PORT))}</span>
      </div>
      <div className={css.connectRow}>
        <Input
          className={css.connectInput}
          value={host}
          aria-label={t("host")}
          onChange={(event) => setHost(event.target.value)}
          placeholder={`192.168.1.12 / peer.example.com / http://host:${DEFAULT_PORT}`}
        />
        <Button type={"submit"} variant={"primary"} disabled={busy || host.trim() === ""}>
          {t("connect")}
        </Button>
      </div>
    </form>
  );
}

function Stat({ label, tone, children }: { label: string; tone?: "warning"; children?: ReactNode }) {
  return (
    <div className={`${ui.card} ${css.stat}`}>
      <span className={css.statLabel}>{label}</span>
      <span className={css.statValue} data-tone={tone}>
        {children}
      </span>
    </div>
  );
}

/** The four numbers that say how this node is doing. */
function Stats({ state }: { state: PodState }) {
  const { self, members, approvals, recent } = state;
  // The host marks the tasks still holding a slot: they are the ones that can be cancelled.
  const active = recent.filter((row) => row.cancellable).length;
  return (
    <div className={css.stats}>
      <Stat label={t("statPeers")}>{members.length}</Stat>
      <Stat label={t("statApprovals")} tone={approvals.length > 0 ? "warning" : undefined}>
        {approvals.length}
      </Stat>
      <Stat label={t("statActive")}>{active}</Stat>
      <Stat label={t("statSelf")}>
        {self?.busy ? (
          <span className={ui.inline} title={`${self.busy.task_id} · ${t("busyOrigin")}${self.busy_from}`}>
            <StateDot state={"ongoing"} size={14} />
            {t("busy")}
          </span>
        ) : (
          <span className={ui.inline}>
            <StateDot state={self ? "done" : "idle"} />
            {self ? t("idle") : t("nodeNotRunning")}
          </span>
        )}
      </Stat>
    </div>
  );
}

function StatusPage({
  snap,
  state,
  frame,
  onOpenSettings,
}: {
  snap: Snapshot;
  state: PodState;
  frame: Frame;
  onOpenSettings: () => void;
}) {
  const { busy } = snap;
  const { self, config, members, approvals, recent, workspace_root } = state;
  const [task, setTask] = React.useState<PodTaskRow | null>(null);
  const [node, setNode] = React.useState<PodPeer | null>(null);
  const [allOpen, setAllOpen] = React.useState(false);
  // The header reflects the live mesh, not the remembered peer list.
  const joined = members.length > 0;
  const error = snap.error ?? snap.actionError ?? config.error;
  const cancel = (row: PodTaskRow) => store.act("cancel", { peer: row.peer, task_id: row.id });
  const body = (
    <div className={ui.stack}>
      <div className={css.header}>
        <div className={css.identity}>
          <div className={css.identityName}>
            <span title={self?.orca_node_id}>{self ? self.display_name : t("nodeNotRunning")}</span>
            <Tag tone={"neutral"}>{config.settings.workgroup_id ?? "-"}</Tag>
            {joined ? <Tag tone={"success"}>{t("meshJoined")}</Tag> : <Tag tone={"outline"}>{t("meshAlone")}</Tag>}
          </div>
          {self ? <div className={`${css.identityMeta} ${ui.mono}`}>{self.orca_node_id}</div> : null}
        </div>
        <div className={css.toolbar}>
          <Tooltip label={t("settings")} side={"bottom"} portal={true}>
            <Button
              variant={"ghost"}
              className={ui.iconButton}
              aria-label={t("settings")}
              icon={<IconSettingsOutlineRegular size={16} />}
              onClick={onOpenSettings}
            />
          </Tooltip>
        </div>
      </div>
      {error ? (
        <p className={css.alert} role={"alert"}>
          <IconWarningOutlineRegular size={14} />
          {error}
        </p>
      ) : null}
      {joined ? null : <ConnectCard busy={busy} />}
      <Stats state={state} />
      {approvals.length > 0 ? (
        <Section title={t("pendingApprovals")} count={approvals.length}>
          <ApprovalList approvals={approvals} busy={busy} />
        </Section>
      ) : null}
      <Section
        title={t("recentTasks")}
        action={
          <Button variant={"ghost"} size={"sm"} onClick={() => setAllOpen(true)}>
            {t("allTasks")}
            <IconChevronRightOutlineRegular size={12} />
          </Button>
        }
      >
        <TaskTable rows={recent} busy={busy} onOpen={setTask} onCancel={cancel} />
      </Section>
      <div className={css.split}>
        <Section title={t("members")} count={members.length}>
          <Members members={members} onOpen={setNode} />
        </Section>
        <Section title={t("workspace")}>
          <Workspace root={workspace_root} />
        </Section>
      </div>
      {allOpen ? <AllTasks onOpen={setTask} onClose={() => setAllOpen(false)} /> : null}
      {task ? <TaskDetail peer={task.peer} taskId={task.id} onClose={() => setTask(null)} /> : null}
      {node ? <NodeDetail member={node} onClose={() => setNode(null)} /> : null}
    </div>
  );
  const footer = (
    <div className={css.footer}>
      <span className={css.footerStatus}>
        {self?.busy ? `${t("busy")} · ${short(self.busy.task_id)} · ${t("busyOrigin")}${self.busy_from}` : null}
      </span>
      <Updated />
    </div>
  );
  return frame(body, footer);
}

/** The overlay puts a view in a DSH dialog; the settings page gives it a title and a sticky footer. */
function frameFor(overlay: boolean, title: string): Frame {
  if (overlay) {
    return (body, footer) => (
      <Modal
        open={true}
        title={title}
        closeLabel={t("close")}
        onClose={() => store.setPanelOpen(false)}
        className={css.dialog}
        contentClassName={css.dialogContent}
        footer={footer}
      >
        {body}
      </Modal>
    );
  }
  return (body, footer) => (
    <section className={css.page}>
      <h2 className={css.pageTitle}>{title}</h2>
      {body}
      <div className={css.pageFooter}>{footer}</div>
    </section>
  );
}

/** The panel body: first-run wizard, status page or settings form. */
export function Panel({ overlay = false }: { overlay?: boolean }) {
  useLocale();
  const snap = useStore();
  const [view, setView] = React.useState<"status" | "settings">("status");
  if (snap.state === null) {
    const waiting = <Empty>{snap.error ? `orca-pod: ${snap.error}` : t("connecting")}</Empty>;
    return frameFor(overlay, t("nav"))(waiting, null);
  }
  const { config } = snap.state;
  const wizard = !config.configured;
  if (wizard || view === "settings") {
    return (
      <ConfigForm
        key={wizard ? "wizard" : "settings"}
        config={config}
        self={snap.state.self}
        members={snap.state.members}
        wizard={wizard}
        onDone={() => setView("status")}
        frame={frameFor(overlay, wizard ? t("nav") : t("settings"))}
      />
    );
  }
  return (
    <StatusPage
      snap={snap}
      state={snap.state}
      frame={frameFor(overlay, t("nav"))}
      onOpenSettings={() => setView("settings")}
    />
  );
}

/** The mesh light, a ◈ drawn rather than typed so it looks the same in every font; it takes the text colour. */
function MeshLight() {
  return (
    <svg width={16} height={16} viewBox={"0 0 16 16"} fill={"none"} aria-hidden={true}>
      <path d={"M8 1.5 14.5 8 8 14.5 1.5 8Z"} stroke={"currentColor"} strokeWidth={1.5} strokeLinejoin={"round"} />
      <path d={"M8 5 11 8 8 11 5 8Z"} fill={"currentColor"} />
    </svg>
  );
}

/** Sidebar-foot entry and status light: grey off the mesh, green with reachable peers, amber while a decision waits. */
export function SidebarAction({ wide }: { wide?: boolean }) {
  useLocale();
  const { state, panelOpen } = useStore();
  const pending = state === null ? 0 : state.approvals.length;
  const reachable = state === null ? 0 : state.members.length;
  const light = pending > 0 ? "warning" : reachable > 0 ? "connected" : undefined;
  const title = pending > 0 ? `${t("nav")} · ${pending} ${t("pendingApprovals")}` : t("nav");
  return (
    <button
      type={"button"}
      className={css.sidebarAction}
      data-wide={wide === false ? "false" : undefined}
      title={title}
      aria-label={title}
      onClick={() => store.setPanelOpen(!panelOpen)}
    >
      <span className={css.sidebarIcon} data-light={light}>
        <MeshLight />
      </span>
      {wide === false ? null : <span className={css.sidebarLabel}>{t("nav")}</span>}
      {wide !== false && pending > 0 ? <Tag tone={"warning"}>{pending}</Tag> : null}
    </button>
  );
}

export function OverlayPanel() {
  useLocale();
  const { panelOpen } = useStore();
  return panelOpen ? <Panel overlay={true} /> : null;
}
