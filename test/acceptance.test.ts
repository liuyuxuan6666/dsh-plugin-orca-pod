import { nodeFetch, type FetchLike } from "../src/mesh/peer-client.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { nodeParts, peersOf } from "./support/node.ts";
import { createMesh } from "./support/harness.ts";
import { Orca } from "../src/node/orca.ts";
import { wg } from "./fixtures/ids.ts";
import { ScriptExecutor, scriptMessage } from "./support/script.ts";

const WORKGROUP = wg("orca-accept");
const PASSWORD = "correct horse";

const FAST = {
  intervalMs: 50,
  suspectAfterMs: 150,
  offlineAfterMs: 300,
  recoverProbeMs: 60,
  maxRecoverProbeMs: 120,
  recordTtlMs: 60_000,
  tombstoneMs: 60_000,
};

async function tempDir(prefix = "orca-accept-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function stateOf(node: Orca, orcaNodeId: string): string | undefined {
  return peersOf(node).find((peer) => peer.orca_node_id === orcaNodeId)?.state;
}

function hangTask() {
  return {
    message: scriptMessage({ final: { state: "hang" as const, text: "" } }),
  };
}

afterEach(async () => {
  // nothing global; every test stops its own nodes
});

describe("acceptance: membership under partition", () => {
  it("marks a cut-off orca node offline and recovers it after the link returns", async () => {
    let blockedPort: string | null = null;
    let blockedIndex = -1;
    const fetchFor =
      (index: number): FetchLike =>
      (url, init) => {
        if (blockedPort !== null && (url.port === blockedPort || index === blockedIndex)) {
          return Promise.reject(new TypeError("simulated network partition"));
        }
        return nodeFetch(url, init);
      };
    const mesh = await createMesh({
      orcaNodes: 3,
      workgroupId: WORKGROUP,
      password: PASSWORD,
      timings: FAST,
      fetch: (index) => fetchFor(index),
    });
    try {
      const [a, b, c] = mesh.orcaNodes;
      if (a === undefined || b === undefined || c === undefined) throw new Error("mesh is short");
      expect(a).toBeDefined();
      await waitFor(
        "three online members",
        () => peersOf(a).length === 2 && peersOf(a).every((peer) => peer.state === "online"),
      );

      blockedPort = new URL(b.mesh.self.endpoints[0]!).port;
      blockedIndex = 1;
      await waitFor(
        "B offline at A and C",
        () => stateOf(a, b.mesh.self.id) === "offline" && stateOf(c, b.mesh.self.id) === "offline",
      );

      blockedPort = null;
      blockedIndex = -1;
      await waitFor(
        "B back online at A and C",
        () => stateOf(a, b.mesh.self.id) === "online" && stateOf(c, b.mesh.self.id) === "online",
      );
    } finally {
      await mesh.stop();
    }
  });

  it("lets only the dispatching origin read a task by id", async () => {
    const mesh = await createMesh({ orcaNodes: 3, workgroupId: WORKGROUP, password: PASSWORD });
    try {
      const [a, b, c] = mesh.orcaNodes;
      if (a === undefined || b === undefined || c === undefined) throw new Error("mesh is short");
      const created = await a.mesh.resolve(b.mesh.self.endpoints[0]!).sendTask({
        message: scriptMessage({ final: { state: "completed", text: "from b" } }),
      });
      let view = await a.mesh.resolve(b.mesh.self.endpoints[0]!).getTask(created.id);
      for (let i = 0; i < 100 && view.status.state !== "completed"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        view = await a.mesh.resolve(b.mesh.self.endpoints[0]!).getTask(created.id);
      }
      expect(view.status.state).toBe("completed");

      // A task id used to be a capability for the whole workgroup; it is now readable
      // only by the origin that dispatched it (§6.5).
      await expect(c.mesh.resolve(b.mesh.self.endpoints[0]!).getTask(created.id)).rejects.toMatchObject({
        code: "not_task_origin",
      });
    } finally {
      await mesh.stop();
    }
  });
});

describe("acceptance: single slot concurrency", () => {
  it("starts exactly one agent turn for ten concurrent dispatches", async () => {
    const root = await tempDir();
    const config = nodeParts({
      workgroup_id: WORKGROUP,
      workgroup_password: PASSWORD,
      data_root: root,
      port: 0,
    });
    const node = new Orca(...config, { executor: new ScriptExecutor() });
    await node.start();
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => node.mesh.resolve(node.mesh.self.endpoints[0]!).sendTask(hangTask())),
      );
      const accepted = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(9);
      for (const result of rejected) {
        if (result.status !== "rejected") continue;
        expect((result.reason as { code?: string }).code).toBe("orca_node_busy");
      }
      const running = accepted[0];
      if (running?.status === "fulfilled") {
        await node.mesh.resolve(node.mesh.self.endpoints[0]!).cancelTask(running.value.id);
      }
    } finally {
      await node.stop();
    }
  });
});

describe("acceptance: password rotation", () => {
  it("rejects a peer that kept the old password", async () => {
    const rootA = await tempDir("orca-rot-a-");
    const rootB = await tempDir("orca-rot-b-");

    const configA1 = nodeParts({
      workgroup_id: WORKGROUP,
      workgroup_password: PASSWORD,
      data_root: rootA,
      port: 0,
    });
    const configB = nodeParts({
      workgroup_id: WORKGROUP,
      workgroup_password: PASSWORD,
      data_root: rootB,
      port: 0,
    });
    const a1 = new Orca(...configA1);
    const b = new Orca(...configB);
    await a1.start();
    await b.start();
    await b.mesh.probe(a1.mesh.self.endpoints[0]!);
    await a1.stop();
    await b.stop();

    const rotatedRoot = await tempDir("orca-rot-new-");
    const rotated = nodeParts({
      workgroup_id: WORKGROUP,
      workgroup_password: "a brand new password",
      data_root: rotatedRoot,
      port: 0,
    });
    const a2 = new Orca(...rotated);
    const b2 = new Orca(...configB);
    await a2.start();
    await b2.start();
    try {
      await expect(b2.mesh.probe(a2.mesh.self.endpoints[0]!)).rejects.toMatchObject({ status: 401 });
      expect(peersOf(b2).some((peer) => peer.orca_node_id === a2.mesh.self.id)).toBe(false);
    } finally {
      await a2.stop();
      await b2.stop();
    }
  });
});
