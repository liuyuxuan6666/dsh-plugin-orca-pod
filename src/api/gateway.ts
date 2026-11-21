import { createServer, type AddressInfo } from "node:net";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { nodeCertificate } from "../core/certificate.ts";
import { bodySha256, buildReplyHeader, REPLY_HEADER } from "../core/signing.ts";
import { PodError, POD_ERROR_STATUS } from "../core/errors.ts";

import type { Mesh } from "../mesh/mesh.ts";
import type { WorkgroupId } from "../core/ids.ts";
import type { NodeIdentity } from "../core/identity.ts";
import type { TrustPolicy } from "../core/trust.ts";
import type { SingleSlotTaskRunner } from "../task/runner.ts";
import { A2aRoutes } from "./a2a-routes.ts";
import { AccessPolicy, parseAuthHeader } from "./access.ts";
import { BlobRoutes } from "./blob-routes.ts";
import { ClusterRoutes } from "./cluster-routes.ts";

/**
 * Default cap for signed requests. Authentication needs the body bytes, so the
 * body is buffered before signature verification; keep that buffer small and
 * raise the limit only where large payloads are expected (§7.1).
 */
const MAX_REQUEST_BYTES = 1024 * 1024;

const BUSY_RETRY_AFTER_S = 30;

/**
 * The inbound HTTP surface of an orca node (§4): the signed routes of the
 * workgroup, the A2A task API, the file routes and this machine's local routes, behind one access policy and
 * one error format; every answer to a signed request is itself signed. The
 * constructor only builds the routes in memory; `listen` binds the port.
 */
export class Gateway {
  /** The HTTP surface: every route behind the access policy; `listen` binds it to a port. */
  readonly app: FastifyInstance;

  constructor(
    private readonly mesh: Mesh,
    tasks: SingleSlotTaskRunner,
    workgroupId: WorkgroupId,
    /** Workgroup key behind the proof of every request (§7.1). */
    key: Buffer,
    private readonly identity: NodeIdentity,
    /** The token this machine's own processes show the local routes. */
    localToken: string,
    /** Directory that `/local/blobs` may publish files from (the workgroup workspace). */
    publishRoot: string,
    /** Who may call this node (§6.5); a refused peer is answered `403 peer_blocked`. */
    trust: TrustPolicy,
  ) {
    // https only (§7.7): the certificate is self-signed over the node's identity key,
    // so a caller pins it to the node id it dials. Nothing is served in plaintext,
    // this machine's own processes included.
    // `forceCloseConnections`: a peer may hold an idle keep-alive socket; shutdown
    // must not wait for it. Routes register no Fastify schemas: each handler parses
    // its input with zod (`input.ts`) after the access policy ran.
    this.app = Fastify({
      logger: false,
      bodyLimit: MAX_REQUEST_BYTES,
      forceCloseConnections: true,
      https: { ...nodeCertificate(identity), minVersion: "TLSv1.3" },
    });
    this.installBodyParsers();
    this.app.setErrorHandler((error, request, reply) => this.handleError(error, request, reply));
    this.app.addHook("onSend", async (request, reply, payload) => this.signReply(request, reply, payload));
    new AccessPolicy(mesh.self.id, workgroupId, key, localToken, trust).install(this.app);
    new ClusterRoutes(mesh).register(this.app);
    new A2aRoutes(tasks, mesh.self.id).register(this.app);
    new BlobRoutes(mesh, publishRoot).register(this.app);
  }

  /**
   * Bind the listener and return its address. Port 0 would let the kernel hand
   * out a port `fetch` refuses to dial (e.g. 6000); pick one it accepts.
   */
  async listen(host: string, port: number): Promise<string> {
    if (port !== 0) {
      if (isBlockedFetchPort(port))
        throw new Error(`listen port ${port} is blocked by fetch; choose another listen port`);
      return this.app.listen({ host, port });
    }
    // The probed port can be taken again before we bind it; retry with a fresh one.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.app.listen({ host, port: await pickFreePort() });
      } catch (error) {
        if (attempt === 5) throw error;
      }
    }
  }

  close(): Promise<void> {
    return this.app.close();
  }

  /**
   * Sign what this node answers (§7.1): the Ed25519 signature covers the nonce of the
   * request being answered, the status and the body, so a reply can be neither
   * changed nor moved to answer another request. Errors are signed too, whatever
   * stopped the request, as long as it named a nonce; a stream (a file) is signed
   * by its status and name, and the caller checks the bytes against the hash the
   * file is named by.
   */
  private signReply(request: FastifyRequest, reply: FastifyReply, payload: unknown): unknown {
    const nonce = parseAuthHeader(request.headers.authorization)?.claim.nonce;
    if (nonce === undefined) return payload;
    let subject: string | undefined;
    if (typeof payload === "string" || Buffer.isBuffer(payload)) subject = bodySha256(payload);
    else if (request.routeOptions.config.blobReply === true) {
      subject = `blob:${(request.params as { blob_id?: string }).blob_id ?? ""}`;
    }
    if (subject !== undefined) {
      reply.header(REPLY_HEADER, buildReplyHeader(this.identity, { nonce, status: reply.statusCode, subject }));
    }
    return payload;
  }

  private installBodyParsers(): void {
    // JSON keeps its bytes for signature verification as well as the parsed value.
    this.app.addContentTypeParser<Buffer>("application/json", { parseAs: "buffer" }, (request, body, done) => {
      request.rawBody = body;
      done(null, body.length === 0 ? undefined : (JSON.parse(body.toString("utf8")) as unknown));
    });
    // Any other media type: bytes for the signature, no parsed body.
    this.app.addContentTypeParser<Buffer>("*", { parseAs: "buffer" }, (request: FastifyRequest, body, done) => {
      request.rawBody = body;
      done(null, undefined);
    });
  }

  /**
   * The one place an error becomes an HTTP response: `{ code, message }` with the
   * status from `POD_ERROR_STATUS`. Routes marked `rpc` wrap the same body in a
   * JSON-RPC error envelope; a busy node also reports its holder and when to retry.
   */
  private handleError(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
    const pod = Gateway.toPodError(error);
    const busy = pod.code === "orca_node_busy";
    const body = {
      code: pod.code,
      message: pod.message,
      ...(busy ? { retry_after_s: BUSY_RETRY_AFTER_S, holder: this.mesh.self.view().busy } : {}),
    };
    if (busy) reply.header("retry-after", String(BUSY_RETRY_AFTER_S));
    const rpcId = (request.body as { id?: unknown } | null | undefined)?.id ?? null;
    return reply
      .code(POD_ERROR_STATUS[pod.code])
      .send(
        request.routeOptions.config.rpc
          ? { jsonrpc: "2.0", id: rpcId, error: { code: -32000, message: pod.code, data: body } }
          : body,
      );
  }

  /** Anything that is not already a PodError is either the caller's malformed input or a bug. */
  private static toPodError(error: unknown): PodError {
    if (error instanceof PodError) return error;
    const { code } = error as FastifyError;
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return new PodError("body_too_large", "request body exceeds the size limit");
    }
    if (error instanceof SyntaxError) return new PodError("bad_request", "invalid JSON body");
    return new PodError("internal", "internal server error");
  }
}

/**
 * Ports the WHATWG fetch standard forbids. `undici` (and browsers) reject a
 * request whose URL names one of them with `fetch failed` / `bad port`, so an
 * orca node must never advertise such a port as its dial endpoint.
 */
const BLOCKED_FETCH_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** True when `fetch` refuses to connect to this port. */
export function isBlockedFetchPort(port: number): boolean {
  return BLOCKED_FETCH_PORTS.has(port);
}

/**
 * Pick a free loopback port that `fetch` may dial.
 *
 * `listen(0)` lets the kernel choose, but it may choose one of the blocked
 * ports above; peers would then fail to reach this orca node with `bad port`.
 * The probe closes immediately; the caller listens on the returned port.
 */
export async function pickFreePort(): Promise<number> {
  for (;;) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (!isBlockedFetchPort(port)) return port;
  }
}
