/**
 * The `orca_pod` file methods (§5.6): `publish` and `fetch`, in the host (through the
 * pod of this process) and inside a task (through this machine's node, `LocalNode`).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import type { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";

import { formatBlobRef } from "../src/core/blobs.ts";
import type { Orca } from "../src/node/orca.ts";
import { LocalNode } from "../src/plugin/tools.ts";
import { PodTool } from "../src/plugin/tools.ts";
import type { OptionalService } from "../src/plugin/services.ts";
import { createGatewayHarness } from "./fixtures/gateway.ts";
import { fakeNodeId } from "./fixtures/ids.ts";
import { podRunning } from "./fixtures/pod.ts";
import { canSymlink } from "./support/symlink.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const OWN = fakeNodeId("own");
const PEER = fakeNodeId("peer");
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-tool-files-"));
  roots.push(root);
  return root;
}

const agent = { id: "session-1", status: "running" as const, session: {}, inject: () => {}, followup: () => {} };

/** A sandbox policy that resolves every session to one mode and workspace. */
const policyOf = (mode: string, workspaceRoot: string) =>
  ({ resolve: () => ({ mode, workspaceRoot }) }) as unknown as SandboxPolicyService;

/** The tool over `node`; `policy` is the session's sandbox policy, when there is one. */
function toolOver(node: ConstructorParameters<typeof PodTool>[0], policy?: SandboxPolicyService) {
  const sandbox = { current: () => policy } as unknown as OptionalService<"sandboxPolicy">;
  const { execute } = new PodTool(node, sandbox).definition();
  return (args: Record<string, unknown>) =>
    execute(args, { signal: new AbortController().signal, agent } as unknown as ToolRunContext);
}

/** The host's tool, over a pod running `node`. */
const toolOf = (node: unknown, policy?: SandboxPolicyService) =>
  toolOver({ kind: "host", pod: podRunning(node) }, policy);

describe("orca_pod publish", () => {
  it("copies a file of the session into the node and answers with its name", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "plan.md"), "the plan");
    const published: Array<[string, number | undefined]> = [];
    const node = {
      mesh: {
        self: {
          publish: async (path: string, ttlS?: number) => {
            published.push([path, ttlS]);
            return { ref: formatBlobRef({ node: OWN, blob_id: sha256("the plan") }), size: 8, expires_at: null };
          },
        },
      },
    } as unknown as Orca;

    const result = await toolOf(
      node,
      policyOf("workspace-write", root),
    )({ method: "publish", path: "plan.md", ttl_s: 0 });

    expect(published).toEqual([[join(root, "plan.md"), 0]]);
    expect(result).toEqual({
      ref: formatBlobRef({ node: OWN, blob_id: sha256("the plan") }),
      size: 8,
      expires_at: null,
    });
  });

  it("allows publishing workspace files under read-only and refuses paths outside the workspace or via symlinks", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(join(root, "notes.md"), "notes");
    writeFileSync(join(outside, "secret.txt"), "secret");
    // Windows without Developer Mode cannot create the link; the escape case is then
    // not set up and the rest of the refusals still hold.
    let symlinked = false;
    if (canSymlink()) {
      symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
      symlinked = true;
    }
    const published: string[] = [];
    const node = {
      mesh: {
        self: {
          publish: async (path: string) => {
            published.push(path);
            return { ref: formatBlobRef({ node: OWN, blob_id: sha256("notes") }), size: 5, expires_at: null };
          },
        },
      },
    } as unknown as Orca;

    await toolOf(node, policyOf("read-only", root))({ method: "publish", path: "notes.md" });
    expect(published).toEqual([join(root, "notes.md")]);

    for (const mode of ["read-only", "workspace-write"]) {
      const call = toolOf(node, policyOf(mode, root));
      await expect(call({ method: "publish", path: join(outside, "secret.txt") })).rejects.toThrow(
        /does not allow publishing/,
      );
      if (symlinked) {
        await expect(call({ method: "publish", path: "escape.txt" })).rejects.toThrow(/does not allow publishing/);
      }
    }
    expect(published).toEqual([join(root, "notes.md")]);
  });

  it("publishes anywhere under danger-full-access, and nowhere when the sandbox policy cannot be read", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(join(outside, "extra.txt"), "extra");
    const published: string[] = [];
    const node = {
      mesh: {
        self: {
          publish: async (path: string) => {
            published.push(path);
            return { ref: formatBlobRef({ node: OWN, blob_id: sha256("extra") }), size: 5, expires_at: null };
          },
        },
      },
    } as unknown as Orca;

    await toolOf(node, policyOf("danger-full-access", root))({ method: "publish", path: join(outside, "extra.txt") });
    expect(published).toEqual([join(outside, "extra.txt")]);

    await expect(toolOf(node)({ method: "publish", path: join(outside, "extra.txt") })).rejects.toThrow(
      /sandbox policy is not available/,
    );
  });

  it("needs a path, and a ttl_s that is a whole number of seconds", async () => {
    const publish = toolOf({} as Orca);
    await expect(publish({ method: "publish" })).rejects.toThrow(/path must be a non-empty string/);
    await expect(publish({ method: "publish", path: "x", ttl_s: -1 })).rejects.toThrow(
      /ttl_s must be a non-negative integer/,
    );
  });
});

describe("orca_pod fetch", () => {
  /** A node whose mesh serves `content` for whatever it is asked. */
  function fetchingNode(content: string) {
    const asked: Array<[string, string]> = [];
    const node = {
      mesh: {
        require: (nodeId: string) => ({
          fetchBlob: async (blobId: string) => {
            asked.push([nodeId, blobId]);
            return { stream: Readable.from([Buffer.from(content)]), size: Buffer.byteLength(content) };
          },
        }),
      },
    } as unknown as Orca;
    return { node, asked };
  }

  it("saves the file where the session sandbox allows writing, checked against the hash in its name", async () => {
    const root = tempRoot();
    const { node, asked } = fetchingNode("the result");
    const ref = formatBlobRef({ node: PEER, blob_id: sha256("the result") });

    const result = await toolOf(
      node,
      policyOf("workspace-write", root),
    )({ method: "fetch", ref, output: "out/result.txt" });

    expect(asked).toEqual([[PEER, sha256("the result")]]);
    expect(readFileSync(join(root, "out", "result.txt"), "utf8")).toBe("the result");
    expect(JSON.stringify(result)).toContain("result.txt");
  });

  it("writes nothing when the bytes are not the ones the name promises", async () => {
    const root = tempRoot();
    const { node } = fetchingNode("something else");
    const ref = formatBlobRef({ node: PEER, blob_id: sha256("what was promised") });

    await expect(
      toolOf(node, policyOf("workspace-write", root))({ method: "fetch", ref, output: "result.txt" }),
    ).rejects.toThrow(/nothing was written/);
    expect(existsSync(join(root, "result.txt"))).toBe(false);
    expect(existsSync(join(root, "result.txt.part"))).toBe(false);
  });

  it.each([
    ["a read-only session", policyOf("read-only", tmpdir()), join(tmpdir(), "orca-tool-files-x.txt")],
    // workspace-write also allows the platform temp dir, so the target has to be somewhere else: the repo.
    ["a path outside the session workspace", policyOf("workspace-write", tmpdir()), join(process.cwd(), "x.txt")],
  ])("refuses to write for %s, and fetches nothing", async (_label, policy, output) => {
    const { node, asked } = fetchingNode("x");
    const ref = formatBlobRef({ node: PEER, blob_id: sha256("x") });

    await expect(toolOf(node, policy)({ method: "fetch", ref, output })).rejects.toThrow(/does not allow writing/);
    expect(asked).toEqual([]);
  });

  it("writes anywhere under danger-full-access, and nowhere when the sandbox policy cannot be read", async () => {
    const root = tempRoot();
    const { node } = fetchingNode("x");
    const ref = formatBlobRef({ node: PEER, blob_id: sha256("x") });

    await toolOf(node, policyOf("danger-full-access", tmpdir()))({ method: "fetch", ref, output: join(root, "x.txt") });
    expect(readFileSync(join(root, "x.txt"), "utf8")).toBe("x");

    await expect(toolOf(node)({ method: "fetch", ref, output: join(root, "y.txt") })).rejects.toThrow(
      /sandbox policy is not available/,
    );
  });

  it("needs a ref that names a published file", async () => {
    await expect(toolOf(fetchingNode("x").node)({ method: "fetch", ref: "not-a-ref", output: "x" })).rejects.toThrow(
      /ref must be <orca node id>\/<sha256>/,
    );
  });
});

describe("orca_pod inside a task", () => {
  /**
   * A gateway listening on loopback (https, its own certificate), and the tool of a
   * task session that reaches it as `LocalNode`, pinned to `node` (the gateway's own id unless given).
   */
  async function taskTool(root: string, options: { token?: string; node?: string } = {}) {
    const harness = createGatewayHarness({ publishRoot: root });
    const url = await harness.url();
    expect(url).toMatch(/^https:\/\//);
    const local = new LocalNode(url, options.node ?? harness.orcaNodeId, options.token ?? harness.localToken);
    return { harness, call: toolOver({ kind: "task", local }, policyOf("workspace-write", root)) };
  }

  it("publishes through this machine's node and fetches back by the name it answered", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "result.md"), "handed back");
    const { harness, call } = await taskTool(root);

    const published = (await call({ method: "publish", path: "result.md" })) as { ref: string; size: number };
    expect(published.ref).toBe(formatBlobRef({ node: harness.mesh.self.id, blob_id: sha256("handed back") }));
    expect(published.size).toBe(11);

    await call({ method: "fetch", ref: published.ref, output: "again.md" });
    expect(readFileSync(join(root, "again.md"), "utf8")).toBe("handed back");
  });

  it("has no method but the file ones, and is refused without the node's token", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "x.txt"), "x");
    const { call } = await taskTool(root);
    // The tool's schema offers only these two: DSH refuses any other before it runs.
    await expect(call({ method: "members" })).rejects.toThrow(/"method" must be one of/);

    const { call: stranger } = await taskTool(root, { token: "not-the-token" });
    await expect(stranger({ method: "publish", path: "x.txt" })).rejects.toThrow(/answered 401/);
  });

  it("will not talk to a node whose certificate is not the one it was told of", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "x.txt"), "x");
    // Pinned to another node's id: the TLS connection is refused before the token is sent.
    const { call } = await taskTool(root, { node: createGatewayHarness().orcaNodeId });
    await expect(call({ method: "publish", path: "x.txt" })).rejects.toThrow(/fetch failed/);
  });

  it("refuses the local routes to another machine, even with the token", async () => {
    const harness = createGatewayHarness();
    const local = { "x-orca-local": harness.localToken, "content-type": "application/json" };
    const payload = JSON.stringify({ path: join(tempRoot(), "x.txt") });
    const elsewhere = await harness.app.inject({
      method: "POST",
      url: "/local/blobs",
      headers: local,
      payload,
      remoteAddress: "192.0.2.7",
    });
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json()).toMatchObject({ code: "not_local" });
    // Through a proxy on this machine is not from this machine either.
    const proxied = await harness.app.inject({
      method: "POST",
      url: "/local/blobs",
      headers: { ...local, "x-forwarded-for": "192.0.2.7" },
      payload,
    });
    expect(proxied.statusCode).toBe(403);
  });
});
