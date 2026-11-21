import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeIdentity } from "../src/core/identity.ts";
import { bodySha256, buildAuthHeader, buildReplyHeader, newNonce, verifyReplyHeader } from "../src/core/signing.ts";
import type { PodError, PodErrorCode } from "../src/core/errors.ts";
import type { OrcaNodeId } from "../src/core/ids.ts";
import { wg } from "./fixtures/ids.ts";
import { generateNodeIdentity } from "../src/plugin/stores.ts";
import { AccessPolicy, parseAuthHeader } from "../src/api/access.ts";
import { parseTrust, TrustPolicy } from "../src/core/trust.ts";
import { deriveWorkgroupKey } from "../src/plugin/pod.ts";

const WORKGROUP_ID = wg("orca-dev");
const PASSWORD = "correct horse battery staple";
const METHOD = "POST";
const PATH = "/a2a/message";
const TARGET = "target-orca-node" as OrcaNodeId;

function freshKey(): Buffer {
  return deriveWorkgroupKey(WORKGROUP_ID, PASSWORD);
}

const KEY = freshKey();

/** How far a request's timestamp may be from the receiver's clock. */
const CLOCK_SKEW_MS = 60_000;

/** A header as a node of the workgroup builds it: both proofs, bound to `TARGET`. */
function header(
  identity: NodeIdentity,
  options: {
    url?: string;
    body?: string;
    ts?: number;
    nonce?: string;
    target?: string;
    key?: Buffer;
    workgroup?: typeof WORKGROUP_ID;
  } = {},
): string {
  return buildAuthHeader(
    identity,
    options.key ?? KEY,
    { method: METHOD, url: options.url ?? PATH, body: options.body },
    {
      target: options.target ?? TARGET,
      workgroupId: options.workgroup ?? WORKGROUP_ID,
      ts: options.ts ?? Date.now(),
      nonce: options.nonce ?? newNonce(),
    },
  );
}

const receivers: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of receivers.splice(0)) await app.close();
});

/** What a receiver answers: who sent the request, or the code it was refused with. */
type Verdict = { orcaNodeId: string } | { code: PodErrorCode };

/**
 * A node as a request reaches it: its access policy in front of one route at
 * `PATH` (a `hello` route takes a request without a target, a `member` route
 * does not). Its process starts when this is called: a request issued earlier
 * is a replay of a previous process.
 */
function receiver(options: { self?: OrcaNodeId; access?: "member" | "hello" } = {}) {
  const app = Fastify();
  receivers.push(app);
  // The gateway keeps the raw bytes for the signature the same way.
  app.addContentTypeParser("*", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = body as Buffer;
    done(null, undefined);
  });
  app.setErrorHandler((error, _request, reply) => reply.code(401).send({ code: (error as PodError).code }));
  new AccessPolicy(
    options.self ?? TARGET,
    WORKGROUP_ID,
    KEY,
    "local-token",
    new TrustPolicy(parseTrust({}), options.self ?? TARGET),
  ).install(app);
  app.post(PATH, { config: { access: options.access ?? "member" } }, (request) => ({
    orcaNodeId: request.auth.orcaNodeId,
  }));
  return {
    async verify(request: { url?: string; body?: string; header: string | undefined }): Promise<Verdict> {
      const reply = await app.inject({
        method: METHOD,
        url: request.url ?? PATH,
        headers: {
          "content-type": "application/octet-stream",
          ...(request.header ? { authorization: request.header } : {}),
        },
        payload: request.body ?? "",
      });
      return reply.json() as Verdict;
    },
  };
}

describe("deriveWorkgroupKey", () => {
  it("derives 32 bytes", () => {
    expect(freshKey()).toHaveLength(32);
  });

  it("uses the memory-hard KDF (known vector)", () => {
    // scrypt(password, "orca-pod\x00<workgroup>", N=2^15, r=8, p=1, len=32).
    expect(freshKey().toString("hex")).toBe("91ccc5f4970b3dfd334eec59e845b15fcc2a416c89ae93505fdfff4ca1f54361");
  });

  it("is deterministic", () => {
    expect(freshKey().equals(freshKey())).toBe(true);
  });

  it("differs by workgroup id", () => {
    const other = deriveWorkgroupKey(wg("orca-other"), PASSWORD);
    expect(other.equals(freshKey())).toBe(false);
  });

  it("differs by password", () => {
    const other = deriveWorkgroupKey(WORKGROUP_ID, "different password");
    expect(other.equals(freshKey())).toBe(false);
  });
});

describe("buildAuthHeader and the receiver's access policy", () => {
  const URL_WITH_QUERY = `${PATH}?task=t_01JABD&x=1`;

  it("roundtrips and returns the signing orca node id", async () => {
    const target = receiver();
    const identity = generateNodeIdentity();
    const body = JSON.stringify({ task_id: "t_01JABD", message: "hello" });
    const signed = header(identity, { url: URL_WITH_QUERY, body });

    expect(signed).toContain(`id=${identity.orcaNodeId}`);
    expect(signed).toContain(`wg=${WORKGROUP_ID}`);
    expect(signed).toContain(`target=${TARGET}`);
    expect(signed).toContain("proof=");
    expect(await target.verify({ url: URL_WITH_QUERY, body, header: signed })).toEqual({
      orcaNodeId: identity.orcaNodeId,
    });
  });

  it("binds the query string and the target into the signature", async () => {
    const target = receiver();
    const elsewhere = receiver({ self: "another-orca-node" as OrcaNodeId });
    const identity = generateNodeIdentity();
    const signed = header(identity, { url: URL_WITH_QUERY });

    expect(await target.verify({ url: `${PATH}?task=other`, header: signed })).toEqual({ code: "bad_signature" });
    expect(await elsewhere.verify({ url: URL_WITH_QUERY, header: signed })).toEqual({ code: "wrong_target" });
  });

  it("rejects a signed request without a target unless the route is a first contact", async () => {
    const member = receiver();
    const hello = receiver({ access: "hello" });
    const identity = generateNodeIdentity();
    expect(await member.verify({ header: header(identity, { target: "" }) })).toEqual({ code: "wrong_target" });
    expect(await hello.verify({ header: header(identity, { target: "" }) })).toEqual({
      orcaNodeId: identity.orcaNodeId,
    });
  });

  it("rejects a request issued before this process started with stale_request", async () => {
    const identity = generateNodeIdentity();
    const signed = header(identity, { ts: Date.now() - 5_000 });
    expect(await receiver().verify({ header: signed })).toEqual({ code: "stale_request" });
  });

  it("rejects a tampered body with bad_signature", async () => {
    const target = receiver();
    const signed = header(generateNodeIdentity(), { body: "original" });
    expect(await target.verify({ body: "tampered", header: signed })).toEqual({ code: "bad_signature" });
  });

  it("rejects a stale timestamp with clock_skew", async () => {
    const target = receiver();
    const signed = header(generateNodeIdentity(), { ts: Date.now() - CLOCK_SKEW_MS - 1_000 });
    expect(await target.verify({ header: signed })).toEqual({ code: "clock_skew" });
  });

  it("rejects a replayed nonce", async () => {
    const target = receiver();
    const identity = generateNodeIdentity();
    const signed = header(identity);
    expect(await target.verify({ header: signed })).toEqual({ orcaNodeId: identity.orcaNodeId });
    expect(await target.verify({ header: signed })).toEqual({ code: "nonce_replay" });
  });

  it("rejects a missing header with missing_auth", async () => {
    expect(await receiver().verify({ header: undefined })).toEqual({ code: "missing_auth" });
  });

  it("rejects a malformed header with malformed_auth", async () => {
    expect(await receiver().verify({ header: "Bearer nope" })).toEqual({ code: "malformed_auth" });
  });

  it("rejects a header carrying a non-Ed25519 orca node id", async () => {
    const forged = `Pod id=ABC123; wg=${WORKGROUP_ID}; ts=1; nonce=n; sig=s; proof=p`;
    expect(await receiver().verify({ header: forged })).toEqual({ code: "malformed_auth" });
  });
});

describe("the two proofs of a request", () => {
  it("refuses a node that is not in the workgroup now: right signature, wrong password", async () => {
    const target = receiver();
    const otherPassword = deriveWorkgroupKey(WORKGROUP_ID, "a password that was changed");
    const signed = header(generateNodeIdentity(), { key: otherPassword });
    expect(await target.verify({ header: signed })).toEqual({ code: "bad_proof" });
  });

  it("refuses a request for another workgroup before looking at the proofs", async () => {
    const target = receiver();
    const signed = header(generateNodeIdentity(), { workgroup: wg("orca-other") });
    expect(await target.verify({ header: signed })).toEqual({ code: "workgroup_mismatch" });
  });

  it("does not let the password stand in for the signature: another node's header cannot be re-signed", async () => {
    // Whoever knows the password still cannot speak as a node it holds no key of: the
    // proof covers exactly the input the signature does, so changing the id breaks the signature.
    const target = receiver();
    const identity = generateNodeIdentity();
    const impostor = generateNodeIdentity();
    const signed = header(identity).replace(`id=${identity.orcaNodeId}`, `id=${impostor.orcaNodeId}`);
    expect(await target.verify({ header: signed })).toEqual({ code: "bad_signature" });
  });

  it("does not let the signature stand in for the password: anyone can make a key pair", async () => {
    const target = receiver();
    const signed = header(generateNodeIdentity(), { key: Buffer.alloc(32, 1) });
    expect(await target.verify({ header: signed })).toEqual({ code: "bad_proof" });
  });

  it("binds the proof to the body as well", async () => {
    const target = receiver();
    const signed = header(generateNodeIdentity(), { body: "original" });
    // A proof over another body fails exactly like the signature does, before the proof is consulted.
    expect(await target.verify({ body: "tampered", header: signed })).toEqual({ code: "bad_signature" });
  });
});

describe("parseAuthHeader", () => {
  it("parses the identity, workgroup, target, timestamp, nonce and both proofs", () => {
    const identity = generateNodeIdentity();
    const signed = header(identity, { target: "target-orca-node", ts: 1_700_000_000_000, nonce: "abc" });
    const parsed = parseAuthHeader(signed);
    expect(parsed).not.toBeNull();
    expect(parsed?.orcaNodeId).toBe(identity.orcaNodeId);
    expect(parsed?.claim).toEqual({
      target: "target-orca-node",
      workgroupId: WORKGROUP_ID,
      ts: 1_700_000_000_000,
      nonce: "abc",
    });
    expect(parsed?.signature.length).toBeGreaterThan(0);
    expect(parsed?.proof.length).toBeGreaterThan(0);
  });

  it("returns null for garbage", () => {
    expect(parseAuthHeader(undefined)).toBeNull();
    expect(parseAuthHeader("")).toBeNull();
    expect(parseAuthHeader("Bearer token")).toBeNull();
    expect(parseAuthHeader("Pod id=x; ts=1; nonce=n")).toBeNull();
    // Both proofs are required: a header without the workgroup proof is not a request of this protocol.
    expect(parseAuthHeader("Pod id=x; wg=orca-dev; ts=1; nonce=n; sig=s")).toBeNull();
    // The sender and the workgroup are checked here: a header naming no node or no workgroup is not one.
    const node = generateNodeIdentity().orcaNodeId;
    expect(parseAuthHeader(`Pod id=${node}; wg=orca-dev; ts=1; nonce=n; sig=s; proof=p`)).not.toBeNull();
    expect(parseAuthHeader("Pod id=ABC123; wg=orca-dev; ts=1; nonce=n; sig=s; proof=p")).toBeNull();
    expect(parseAuthHeader(`Pod id=${node}; wg=Orca Dev; ts=1; nonce=n; sig=s; proof=p`)).toBeNull();
    expect(parseAuthHeader(`Pod id=${node}; wg=orca-dev; ts=; nonce=n; sig=s; proof=p`)).toBeNull();
  });
});

describe("reply signature", () => {
  const identity = generateNodeIdentity();
  const fields = { nonce: "request-nonce", status: 200, subject: bodySha256('{"ok":true}') };

  it("names the node that signed, over the nonce, the status and the body", () => {
    expect(verifyReplyHeader(buildReplyHeader(identity, fields), fields)).toBe(identity.orcaNodeId);
  });

  it("does not hold for another request's nonce: a reply cannot be moved", () => {
    const signed = buildReplyHeader(identity, fields);
    expect(verifyReplyHeader(signed, { ...fields, nonce: "another-nonce" })).toBeNull();
  });

  it("does not hold for another status or another body", () => {
    const signed = buildReplyHeader(identity, fields);
    expect(verifyReplyHeader(signed, { ...fields, status: 500 })).toBeNull();
    expect(verifyReplyHeader(signed, { ...fields, subject: bodySha256('{"ok":false}') })).toBeNull();
  });

  it("is refused when absent, malformed, or signed in another id's name", () => {
    expect(verifyReplyHeader(undefined, fields)).toBeNull();
    expect(verifyReplyHeader("garbage", fields)).toBeNull();
    const other = generateNodeIdentity();
    const forged = buildReplyHeader(identity, fields).replace(identity.orcaNodeId, other.orcaNodeId);
    expect(verifyReplyHeader(forged, fields)).toBeNull();
  });

  it("covers a streamed file by its name instead of its body", () => {
    const stream = { nonce: "n", status: 200, subject: `blob:${"a".repeat(64)}` };
    expect(verifyReplyHeader(buildReplyHeader(identity, stream), stream)).toBe(identity.orcaNodeId);
    expect(
      verifyReplyHeader(buildReplyHeader(identity, stream), { ...stream, subject: `blob:${"b".repeat(64)}` }),
    ).toBeNull();
  });
});
