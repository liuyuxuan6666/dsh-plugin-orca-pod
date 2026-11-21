import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bodySha256 } from "../src/core/signing.ts";
import { FileBlobRegistry } from "../src/core/blobs.ts";
import { PodError } from "../src/core/errors.ts";
import { SqliteDb } from "../src/core/sqlite.ts";
import type { BusyState } from "../src/task/wire.ts";
import type { SingleSlotTaskRunner } from "../src/task/runner.ts";
import { createGatewayHarness, type GatewayHarness } from "./fixtures/gateway.ts";
import { createTestRunner, openDb, tempDir } from "./fixtures/runner.ts";
import { canSymlink } from "./support/symlink.ts";
import { generateNodeIdentity } from "../src/plugin/stores.ts";

const createHarness = (tasks?: SingleSlotTaskRunner, blobs?: FileBlobRegistry): GatewayHarness =>
  createGatewayHarness({ tasks, blobs });

/** A registry over a fresh database and a directory of its own. */
const registry = (db = openDb()): FileBlobRegistry => new FileBlobRegistry(db, tempDir("orca-blob-copies-"));

/** A file of this machine, outside any registry. */
async function localFile(content: Buffer | string, name = "result.bin"): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "orca-blob-source-")), name);
  await writeFile(path, content);
  return path;
}

/** A file published on the harness node. */
async function published(
  content: Buffer,
): Promise<{ harness: GatewayHarness; blobId: string; path: string; copy: string }> {
  const path = await localFile(content);
  const fileBlobs = registry();
  const { blob_id: blobId, path: copy } = await fileBlobs.register(path, 120);
  return { harness: createHarness(createTestRunner(), fileBlobs), blobId, path, copy };
}

const signedGet = (harness: GatewayHarness, url: string) =>
  harness.app.inject({ method: "GET", url, headers: { authorization: harness.sign("GET", url) } });

describe("blob route", () => {
  it("serves a published file to a member's signed request", async () => {
    const content = Buffer.from("signed read");
    const { harness, blobId } = await published(content);
    const response = await signedGet(harness, `/blobs/${blobId}`);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(content)).toBe(true);
  });

  it("refuses an unsigned request", async () => {
    const { harness, blobId } = await published(Buffer.from("private"));
    const response = await harness.app.inject({ method: "GET", url: `/blobs/${blobId}` });
    expect(response.statusCode).toBe(401);
  });

  it("serves its own copy: changing or deleting the original changes nothing", async () => {
    const content = Buffer.from("published once");
    const { harness, blobId, path } = await published(content);
    await writeFile(path, "edited afterwards");
    let response = await signedGet(harness, `/blobs/${blobId}`);
    expect(response.rawPayload.equals(content)).toBe(true);
    await rm(path);
    response = await signedGet(harness, `/blobs/${blobId}`);
    expect(response.statusCode).toBe(200);
  });

  it("answers 410 blob_file_missing once its copy is gone", async () => {
    const { harness, blobId, copy } = await published(Buffer.from("deleted later"));
    await rm(copy);
    const response = await signedGet(harness, `/blobs/${blobId}`);
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ code: "blob_file_missing" });
  });

  it("rejects an oversized JSON body before the route handler runs", async () => {
    const harness = createHarness();
    const body = JSON.stringify({ workgroup_id: "orca-dev", padding: "x".repeat(1024 * 1024) });
    const response = await harness.app.inject({
      method: "POST",
      url: "/cluster/join",
      payload: body,
      headers: {
        "content-type": "application/json",
        authorization: harness.sign("POST", "/cluster/join", body),
      },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "body_too_large" });
  });
});

describe("the blob registry", () => {
  it("copies a file in under its sha256", async () => {
    const content = Buffer.from("# findings\n");
    const path = await localFile(content, "report.md");
    const blob = await registry().register(path, 120);
    expect(blob.blob_id).toBe(bodySha256(content));
    expect(blob.size).toBe(content.length);
    expect(blob.expires_at).not.toBeNull();
    expect(blob.path).not.toBe(path);
    expect(await readFile(blob.path)).toEqual(content);
  });

  it("keeps the mapping in SQLite so a later process sees it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-blob-file-"));
    const filePath = join(dir, "artifact.bin");
    await writeFile(filePath, Buffer.from([1, 2, 3, 4]));
    const copies = join(dir, "blobs");
    const dbPath = join(dir, "tasks.db");

    const writerDb = new SqliteDb(dbPath);
    writerDb.open();
    const blob = await new FileBlobRegistry(writerDb, copies).register(filePath, 60);
    writerDb.close();
    expect(blob.path).toBe(join(copies, blob.blob_id));

    const readerDb = new SqliteDb(dbPath);
    readerDb.open();
    const opened = new FileBlobRegistry(readerDb, copies).open(blob.blob_id);
    const bytes: Buffer[] = [];
    for await (const chunk of opened.stream) bytes.push(chunk as Buffer);
    readerDb.close();
    expect(opened.size).toBe(4);
    expect(Buffer.concat(bytes)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("refuses a missing path or directory instead of registering it, and leaves nothing behind", async () => {
    const blobs = registry();
    const dir = await mkdtemp(join(tmpdir(), "orca-blob-file-"));
    await expect(blobs.register(join(dir, "absent.txt"))).rejects.toThrow();
    await expect(blobs.register(dir)).rejects.toThrow(/not a regular file/);
  });

  it("keeps the later expiry when the same bytes are published again; 0 never expires", async () => {
    const blobs = registry();
    const path = await localFile("same bytes");
    const long = await blobs.register(path, 3600);
    expect((await blobs.register(path, 60)).expires_at).toBe(long.expires_at);
    expect((await blobs.register(path, 0)).expires_at).toBeNull();
    expect((await blobs.register(path, 60)).expires_at).toBeNull();
  });

  it("sweeps an expired file with its row when it starts, and never a file it did not copy", async () => {
    const db = openDb();
    const blobs = registry(db);
    const expiring = await blobs.register(await localFile("short-lived"), 1);
    const kept = await blobs.register(await localFile("long-lived"), 3600);
    // A row an older version wrote: it names the publisher's own file.
    const foreign = await localFile("the user's file");
    db.db
      .prepare("INSERT INTO file_blobs (blob_id, path, size, expires_at) VALUES (?, ?, ?, ?)")
      .run("f".repeat(64), foreign, 15, new Date(0).toISOString());

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2000);
      blobs.start();
      blobs.stop();
    } finally {
      vi.useRealTimers();
    }
    expect(() => blobs.open(expiring.blob_id)).toThrow(PodError);
    expect(existsSync(expiring.path)).toBe(false);
    const stillThere = blobs.open(kept.blob_id);
    for await (const _chunk of stillThere.stream) {
      // Read to the end, so the file is closed before the test cleans up.
    }
    expect(stillThere.size).toBe(kept.size);
    expect(existsSync(kept.path)).toBe(true);
    expect(() => blobs.open("f".repeat(64))).toThrow(/blob_not_found/);
    expect(existsSync(foreign)).toBe(true);
  });
});

describe("local routes", () => {
  const local = (harness: GatewayHarness, token = harness.localToken) => ({ "x-orca-local": token });

  it("publish a file inside the workgroup workspace and name it by this node", async () => {
    const harness = createHarness();
    const content = Buffer.from("handed back");
    const path = join(harness.publishRoot, "result.bin");
    await writeFile(path, content);
    const response = await harness.app.inject({
      method: "POST",
      url: "/local/blobs",
      payload: { path, ttl_s: 60 },
      headers: local(harness),
    });
    expect(response.statusCode).toBe(200);
    const blobId = bodySha256(content);
    expect(response.json()).toMatchObject({ ref: `${harness.orcaNodeId}/${blobId}`, size: content.length });
    // Members fetch it the usual way.
    expect((await signedGet(harness, `/blobs/${blobId}`)).rawPayload.equals(content)).toBe(true);
  });

  it("refuses paths outside the workgroup workspace, traversal, and symlink escapes", async () => {
    const harness = createHarness();
    const secret = await localFile("host secret", "secret.txt");
    const escaped = join(harness.publishRoot, "link.txt");
    // Windows without Developer Mode cannot make the symlink at all: the escape
    // case is then not set up, and the other refusals still hold.
    const symlinked =
      canSymlink() &&
      (await symlink(secret, escaped).then(
        () => true,
        () => false,
      ));
    const traversal = join(harness.publishRoot, "..", "nonexistent.txt");

    for (const path of [secret, ...(symlinked ? [escaped] : []), traversal, harness.publishRoot]) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/local/blobs",
        payload: { path },
        headers: local(harness),
      });
      expect(response.statusCode, path).toBe(403);
      expect(response.json()).toMatchObject({ code: "path_outside_workspace" });
    }
  });

  it("serve a file through this node, its own or another member's", async () => {
    const harness = createHarness();
    const content = Buffer.from("own file");
    const { blob_id: blobId } = await harness.blobs.register(await localFile(content));
    const own = await harness.app.inject({
      method: "GET",
      url: `/local/blobs/${harness.orcaNodeId}/${blobId}`,
      headers: local(harness),
    });
    expect(own.statusCode).toBe(200);
    expect(own.rawPayload.equals(content)).toBe(true);

    // A node this one does not know cannot be asked.
    const stranger = await harness.app.inject({
      method: "GET",
      url: `/local/blobs/${generateNodeIdentity().orcaNodeId}/${blobId}`,
      headers: local(harness),
    });
    expect(stranger.statusCode).toBe(404);
  });

  it("refuse a caller without this node's token, and a path that is not absolute", async () => {
    const harness = createHarness();
    const path = await localFile("x");
    for (const headers of [{}, local(harness, "not-the-token")]) {
      const response = await harness.app.inject({ method: "POST", url: "/local/blobs", payload: { path }, headers });
      expect(response.statusCode).toBe(401);
    }
    const relative = await harness.app.inject({
      method: "POST",
      url: "/local/blobs",
      payload: { path: "result.bin" },
      headers: local(harness),
    });
    expect(relative.statusCode).toBe(400);
  });
});

describe("a2a busy response", () => {
  it("answers orca_node_busy with 429, Retry-After and the holder", async () => {
    const holder: BusyState = {
      task_id: "TASK1",
      origin_orca_node: generateNodeIdentity().orcaNodeId,
      since: new Date().toISOString(),
    };
    const tasks = createTestRunner();
    vi.spyOn(tasks, "submit").mockImplementation(() => {
      throw new PodError("orca_node_busy", "node is busy");
    });
    const harness = createHarness(tasks);
    // The node's own row reports the runner's slot; the gateway reports that.
    vi.spyOn(tasks, "busy").mockReturnValue(holder);
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text: "hi" }] } },
    });
    const response = await harness.app.inject({
      method: "POST",
      url: "/a2a",
      payload,
      headers: {
        "content-type": "application/json",
        authorization: harness.sign("POST", "/a2a", payload),
      },
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.json()).toEqual({
      jsonrpc: "2.0",
      id: "req-1",
      error: {
        code: -32000,
        message: "orca_node_busy",
        data: { code: "orca_node_busy", message: "node is busy", retry_after_s: 30, holder },
      },
    });
  });
});
