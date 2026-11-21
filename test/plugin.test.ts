import { describe, expect, it, vi } from "vitest";

import { parseSettings } from "../src/node/settings.ts";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Pod } from "../src/plugin/pod.ts";
import type { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import type { OptionalService } from "../src/plugin/services.ts";
import { PodTool } from "../src/plugin/tools.ts";
import { fakeNodeId } from "./fixtures/ids.ts";
import { idlePod, podRunning } from "./fixtures/pod.ts";
import * as plugin from "../src/plugin/bundle.ts";

/** The `orca_pod` tool of a pod; `policy` is the host's sandbox policy, when it has one. */
function createPodTools(pod: Pod, policy?: () => SandboxPolicyService | undefined): ToolDefinition[] {
  // The host's optional service, reduced to the one read the tool makes; a host without it has none.
  const sandbox = { current: policy ?? (() => undefined) } as unknown as OptionalService<"sandboxPolicy">;
  return [new PodTool({ kind: "host", pod }, sandbox).definition()];
}

function tool(result: ReturnType<typeof createPodTools>) {
  const found = result.find((candidate) => candidate.name === "orca_pod");
  if (found === undefined) throw new Error("missing tool orca_pod");
  return found;
}

/** The host always supplies a run context; tests default it for argument-validation cases. */
function run(tools: ReturnType<typeof createPodTools>, args: unknown, exec: Record<string, unknown> = {}) {
  const { execute } = tool(tools);
  return execute(args, { signal: new AbortController().signal, ...exec } as unknown as ToolRunContext);
}

describe("settings", () => {
  it("applies defaults and keeps optional fields absent", () => {
    const config = parseSettings({ workgroup_id: "wg-a", workgroup_password: "pw" });
    expect(config).toEqual({
      workgroup_id: "wg-a",
      bind_host: "127.0.0.1",
      port: 11811,
      endpoints: [],
      peers: [],
      task_timeout_s: 3600,
      max_workspace_bytes: 5 * 1024 ** 3,
      trust: { inbound: "allow", outbound: "allow", peers: {} },
    });
  });

  it("keeps explicit values", () => {
    const config = parseSettings({
      workgroup_id: "wg-a",
      workgroup_password: "pw",
      display_name: "pod-a",
      port: 0,
      endpoints: ["https://127.0.0.1:9000"],
      peers: ["https://127.0.0.1:11811"],
    });
    expect(config.port).toBe(0);
    expect(config.display_name).toBe("pod-a");
    expect(config.endpoints).toEqual(["https://127.0.0.1:9000"]);
    expect(config.peers).toEqual(["https://127.0.0.1:11811"]);
  });

  it("allows starting without a workgroup so the panel can run its wizard", () => {
    expect(parseSettings({})).toEqual({
      bind_host: "127.0.0.1",
      port: 11811,
      endpoints: [],
      peers: [],
      task_timeout_s: 3600,
      max_workspace_bytes: 5 * 1024 ** 3,
      trust: { inbound: "allow", outbound: "allow", peers: {} },
    });
  });

  it("rejects an invalid workgroup id", () => {
    expect(() => parseSettings({ workgroup_id: "Bad ID", workgroup_password: "pw" })).toThrow(/workgroup_id/);
  });

  it("rejects malformed peers", () => {
    expect(() =>
      parseSettings({
        workgroup_id: "wg-a",
        workgroup_password: "pw",
        peers: ["not a url"],
      }),
    ).toThrow(/peers/);
  });
});

describe("plugin config", () => {
  const validate = (input: unknown) => plugin.Config["~standard"].validate(input);

  it("is the skill switch and nothing else, on by default", () => {
    expect(validate({})).toEqual({ value: { skill_injection: true } });
    expect(validate(undefined)).toEqual({ value: { skill_injection: true } });
    expect(validate({ skill_injection: null })).toEqual({ value: { skill_injection: true } });
    expect(validate({ skill_injection: false })).toEqual({ value: { skill_injection: false } });
    expect(validate({ skill_injection: "yes" })).toMatchObject({ issues: [{ path: ["skill_injection"] }] });
  });

  it("ignores node settings an older profile patch still carries", () => {
    expect(
      validate({ workgroup_id: "wg-a", workgroup_password_ref: "MY_PASSWORD", port: 1, skill_injection: true }),
    ).toEqual({
      value: { skill_injection: true },
    });
  });

  it("declares the tool registry and credential store as hard dependencies, and no config editor", () => {
    expect(plugin.inject).toEqual(["tools", "credentials"]);
  });
});

describe("orca_pod tool", () => {
  const handle = idlePod({ workgroup_id: "wg-a", workgroup_password: "pw" });
  const tools = createPodTools(handle);

  it("registers exactly one orca_pod tool", () => {
    expect(tools.map((candidate) => candidate.name)).toEqual(["orca_pod"]);
  });

  it("documents the methods and asynchronous remote execution", () => {
    const description = tool(tools).description;
    for (const method of ["send", "status", "cancel", "members", "connect"]) {
      expect(description).toContain(method);
    }
    expect(description).not.toContain("§");
    expect(description).toContain("asynchronously");
    expect(description).toContain("task_id");
  });

  it("renders results as JSON text", () => {
    const blocks = tool(tools).output.render({}, { self: { orca_node_id: "abc" } });
    expect(blocks).toEqual([{ type: "text", text: JSON.stringify({ self: { orca_node_id: "abc" } }, null, 2) }]);
  });

  it("requires a known method", async () => {
    await expect(run(tools, {})).rejects.toThrow(/method/);
    await expect(run(tools, { method: "nope" })).rejects.toThrow(/"method" must be one of/);
  });

  it("validates each method's arguments before touching the orca node", async () => {
    await expect(run(tools, { method: "send" })).rejects.toThrow(/peer/);
    await expect(run(tools, { method: "send", peer: "http://127.0.0.1:1" })).rejects.toThrow(/text/);
    await expect(run(tools, { method: "status", peer: "http://127.0.0.1:1" })).rejects.toThrow(/task_id/);
    await expect(run(tools, { method: "cancel", peer: "http://127.0.0.1:1" })).rejects.toThrow(/task_id/);
    await expect(run(tools, { method: "connect" })).rejects.toThrow(/peer/);
    await expect(run(tools, { method: "connect", peer: "not a url" })).rejects.toThrow(/http/);
  });

  it("rejects a malformed model selector before touching the orca node", async () => {
    await expect(run(tools, { method: "send", peer: "http://127.0.0.1:1", text: "hi", model: "nope" })).rejects.toThrow(
      /provider\/model/,
    );
  });

  it("fails clearly when the orca node is not running", async () => {
    await expect(run(tools, { method: "send", peer: "http://127.0.0.1:1", text: "hi" })).rejects.toThrow(
      /orca node is not running/,
    );
    await expect(run(tools, { method: "members" })).rejects.toThrow(/orca node is not running/);
    await expect(run(tools, { method: "connect", peer: "127.0.0.1:11811" })).rejects.toThrow(
      /orca node is not running/,
    );
  });

  it("inherits the dispatching session's permission mode when send omits one", async () => {
    const sent: unknown[] = [];
    const fakeNode = {
      mesh: {
        resolve: () => ({
          id: fakeNodeId("target"),
          displayName: "target",
          sendTask: async (input: unknown) => {
            sent.push(input);
            return { id: "task-1", status: { state: "submitted" } };
          },
        }),
      },
    } as unknown as import("../src/node/orca.ts").Orca;
    const handleForSend = podRunning(fakeNode);
    const session = {};
    const sandbox = { resolve: () => ({ mode: "workspace-write" }) } as unknown as SandboxPolicyService;
    const sendTools = createPodTools(handleForSend, () => sandbox);
    const agent = {
      id: "session-1",
      status: "running" as const,
      session,
      inject: () => {},
      followup: () => {},
    };
    await run(sendTools, { method: "send", peer: "http://127.0.0.1:11811", text: "hi" }, { agent });
    const inherited = sent[0] as { metadata?: { pod?: Record<string, unknown> } };
    expect(inherited.metadata?.pod?.permission_mode).toBe("workspace-write");

    await run(
      sendTools,
      { method: "send", peer: "http://127.0.0.1:11811", text: "hi", permission_mode: "read-only" },
      { agent },
    );
    const explicit = sent[1] as { metadata?: { pod?: Record<string, unknown> } };
    expect(explicit.metadata?.pod?.permission_mode).toBe("read-only");

    // A task can only start narrower than the session; more is asked for as an upgrade (P1).
    await expect(
      run(
        sendTools,
        { method: "send", peer: "http://127.0.0.1:11811", text: "hi", permission_mode: "danger-full-access" },
        { agent },
      ),
    ).rejects.toThrow(/wider than this session's workspace-write/);
    expect(sent).toHaveLength(2);

    // A session whose mode cannot be read counts as read-only.
    const blind = createPodTools(handleForSend);
    await run(blind, { method: "send", peer: "http://127.0.0.1:11811", text: "hi" }, { agent });
    expect((sent[2] as { metadata?: { pod?: Record<string, unknown> } }).metadata?.pod?.permission_mode).toBe(
      "read-only",
    );
  });

  it("hands the dispatching session to the dispatch, so the log has it from the start", async () => {
    const options: unknown[] = [];
    const fakeNode = {
      mesh: {
        resolve: () => ({
          id: fakeNodeId("target"),
          displayName: "target",
          sendTask: async (_input: unknown, given: unknown) => {
            options.push(given);
            return { id: "task-1", status: { state: "submitted" } };
          },
        }),
      },
    } as unknown as import("../src/node/orca.ts").Orca;
    const sendTools = createPodTools(podRunning(fakeNode));
    const agent = { id: "session-1", status: "running" as const, inject: () => {}, followup: () => {} };

    await run(sendTools, { method: "send", peer: "http://127.0.0.1:11811", text: "hi" }, { agent });
    expect(options[0]).toMatchObject({ agentId: "session-1" });

    // A call without a session (the CLI, a host without sessions) dispatches without one.
    await run(sendTools, { method: "send", peer: "http://127.0.0.1:11811", text: "hi" }, {});
    expect((options[1] as { agentId?: string }).agentId).toBeUndefined();
  });

  it("forwards the caller's abort signal and cancels a task accepted after the turn was cancelled", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const cancelled: string[] = [];
    const fakeNode = {
      mesh: {
        resolve: () => ({
          id: fakeNodeId("target"),
          displayName: "target",
          sendTask: async (_input: unknown, options?: { signal?: AbortSignal }) => {
            signals.push(options?.signal);
            // The remote accepts, but the user cancels the turn before the reply lands.
            controller.abort();
            return { id: "task-late", status: { state: "submitted" } };
          },
          cancelTask: async (taskId: string) => {
            cancelled.push(taskId);
            return { id: taskId, status: { state: "canceled" } };
          },
        }),
      },
    } as unknown as import("../src/node/orca.ts").Orca;
    const handleForSend = podRunning(fakeNode);
    const sendTools = createPodTools(handleForSend);
    const agent = { id: "session-1", status: "running" as const, inject: () => {}, followup: () => {} };
    await expect(
      run(
        sendTools,
        { method: "send", peer: "http://127.0.0.1:11811", text: "hi" },
        { agent, signal: controller.signal },
      ),
    ).rejects.toThrow(/cancelled by the caller/);
    expect(signals[0]).toBe(controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    expect(cancelled).toEqual(["task-late"]);
  });

  it("settles a cancelled call only after its own work has stopped (B20)", async () => {
    const controller = new AbortController();
    let finishSend: (() => void) | undefined;
    let sendSettled = false;
    const fakeNode = {
      mesh: {
        resolve: () => ({
          id: fakeNodeId("target"),
          displayName: "target",
          sendTask: (_input: unknown, { signal }: { signal: AbortSignal }) =>
            new Promise((resolve) => {
              // The outbound request notices the abort but takes a moment to wind down.
              signal.addEventListener("abort", () => {
                finishSend = () => {
                  sendSettled = true;
                  resolve({ id: "task-slow", status: { state: "submitted" } });
                };
              });
            }),
          cancelTask: async (taskId: string) => ({ id: taskId, status: { state: "canceled" } }),
        }),
      },
    } as unknown as import("../src/node/orca.ts").Orca;
    const handleForSend = podRunning(fakeNode);
    const sendTools = createPodTools(handleForSend);
    let settled = false;
    const call = run(
      sendTools,
      { method: "send", peer: "http://127.0.0.1:11811", text: "hi" },
      { signal: controller.signal },
    ).finally(() => {
      settled = true;
    });
    call.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    // The turn is cancelled, but the request it started has not stopped yet.
    expect(settled).toBe(false);
    finishSend?.();
    await expect(call).rejects.toThrow(/cancelled by the caller/);
    expect(sendSettled).toBe(true);
  });

  it("does not dispatch at all when the turn is already cancelled", async () => {
    let sent = 0;
    const fakeNode = {
      mesh: {
        resolve: () => ({
          id: fakeNodeId("target"),
          displayName: "target",
          sendTask: async () => {
            sent += 1;
            return { id: "never", status: { state: "submitted" } };
          },
        }),
      },
    } as unknown as import("../src/node/orca.ts").Orca;
    const handleForSend = podRunning(fakeNode);
    const sendTools = createPodTools(handleForSend);
    await expect(
      run(sendTools, { method: "send", peer: "http://127.0.0.1:11811", text: "hi" }, { signal: AbortSignal.abort() }),
    ).rejects.toThrow(/cancelled by the caller/);
    expect(sent).toBe(0);
  });

  it("starts a task read-only when the session or its sandbox policy cannot be read", async () => {
    const sent: unknown[] = [];
    const fakeNode = {
      mesh: {
        resolve: () => ({
          id: fakeNodeId("target"),
          displayName: "target",
          sendTask: async (input: unknown) => {
            sent.push(input);
            return { id: "task-1", status: { state: "submitted" } };
          },
        }),
      },
    } as unknown as import("../src/node/orca.ts").Orca;
    /** The policy service the host exposes as `ctx.sandboxPolicy`. */
    const policy = { resolve: () => ({ mode: "danger-full-access" }) } as unknown as SandboxPolicyService;
    const sendTools = createPodTools(podRunning(fakeNode), () => policy);
    const call = { method: "send", peer: "http://127.0.0.1:11811", text: "hi" } as const;
    const agentWithout = { id: "session-1", status: "running" as const, inject: () => {}, followup: () => {} };

    // No agent, or an agent that has no session: there is no mode to inherit.
    await run(sendTools, call, {});
    await run(sendTools, call, { agent: agentWithout });
    // A session the policy resolves is inherited.
    await run(sendTools, call, { agent: { ...agentWithout, session: {} } });
    const modes = sent.map(
      (input) => (input as { metadata?: { pod?: { permission_mode?: string } } }).metadata?.pod?.permission_mode,
    );
    expect(modes).toEqual(["read-only", "read-only", "danger-full-access"]);
  });

  it("joins a peer and returns the refreshed members", async () => {
    const seen: string[] = [];
    const fakeNode = {
      mesh: { peers: () => [], digest: () => "digest" },
    } as unknown as import("../src/node/orca.ts").Orca;
    const handleForConnect = podRunning(fakeNode);
    vi.spyOn(handleForConnect, "addPeer").mockImplementation(async (address: string) => {
      seen.push(address);
      return "http://192.168.1.20:11811";
    });
    const connectTools = createPodTools(handleForConnect);
    const result = await run(connectTools, { method: "connect", peer: "192.168.1.20" });
    // The pod makes the address canonical; the tool answers with what the pod joined.
    expect(seen).toEqual(["192.168.1.20"]);
    expect(result).toEqual({
      peer: "http://192.168.1.20:11811",
      members: [],
      members_digest: "digest",
    });
  });
});
