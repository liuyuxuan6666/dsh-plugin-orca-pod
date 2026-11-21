import { HarnessError } from "@deepseek-ai/dsh-error";

/**
 * Every stable error code this node emits, with the HTTP status it maps to.
 * One table: a code cannot exist without a status, and `PodErrorCode` is derived
 * from it, so a thrown code that is not listed here does not compile.
 */
export const POD_ERROR_STATUS = {
  // Request authentication (§7.1).
  missing_auth: 401,
  malformed_auth: 401,
  clock_skew: 401,
  nonce_replay: 401,
  bad_signature: 401,
  wrong_target: 401,
  stale_request: 401,
  bad_proof: 401,
  // Authorization.
  not_task_origin: 403,
  /** A peer this node does not trust asked it for something: its `inbound` verdict is `deny` (§6.5). */
  peer_blocked: 403,
  /** This node is not allowed to call that peer: its `outbound` verdict is `deny` (§6.5). */
  peer_not_permitted: 403,
  /** A local route asked from another machine, or through a proxy (§5.6). */
  not_local: 403,
  /** A local blob publish asked for a path outside the workgroup workspace (§5.6). */
  path_outside_workspace: 403,
  // Malformed or unsupported requests.
  bad_request: 400,
  unsupported: 400,
  workgroup_mismatch: 400,
  /** A hello whose declared endpoints are all forbidden by the screening policy (§7.7). */
  endpoint_refused: 400,
  // Unknown resources.
  task_not_found: 404,
  blob_not_found: 404,
  unknown_orca_node: 404,
  // State conflicts.
  permission_denied: 409,
  // Gone.
  blob_expired: 410,
  blob_file_missing: 410,
  // Limits.
  body_too_large: 413,
  orca_node_busy: 429,
  quota_exceeded: 507,
  internal: 500,
  // Outbound calls (see mesh/peer-client.ts): raised on this node, never sent over the wire.
  unknown_peer: 404,
  peer_not_online: 503,
  peer_error: 502,
  peer_timeout: 504,
} as const satisfies Record<string, number>;

export type PodErrorCode = keyof typeof POD_ERROR_STATUS;

/**
 * The one error type of this node, a DSH `HarnessError` whose code is one of
 * ours: the gateway turns it into an HTTP response
 * (see api/gateway.ts), and the peer client raises it for a failed
 * outbound call, with the status the peer answered with.
 */
export class PodError extends HarnessError {
  declare readonly code: PodErrorCode;
  readonly status: number;

  constructor(code: PodErrorCode, message: string = code, status: number = POD_ERROR_STATUS[code]) {
    super(message, code);
    this.status = status;
  }
}

/** True when a filesystem call failed because the path does not exist (no `instanceof`: errors may cross realms). */
export function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** The error a cancelled operation rejects with; callers tell it apart by `name`. */
export function abortError(message = "aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** A printable message for an arbitrary thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
