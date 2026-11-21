/**
 * A node's settings: `SettingsSchema` declares every setting once, with its
 * schema and default, and `PanelPatchSchema` names the ones the panel edits.
 * The settings file, the panel and the tests all go through `parseSettings`;
 * nothing else validates a setting.
 */

import { z } from "zod";

import { normalizePeerUrl } from "../core/net.ts";
import { EndpointsSchema } from "../mesh/wire.ts";
import { DEFAULT_PORT } from "../core/constants.ts";
import { HarnessError } from "@deepseek-ai/dsh-error";
import { ModelSettingsSchema } from "../executor/model-catalog.ts";
import { TaskSettingsSchema } from "../task/record.ts";
import { TrustSettingsSchema } from "../core/trust.ts";
import { WorkgroupIdSchema } from "../core/ids.ts";
import { errorMessage } from "../core/errors.ts";
import { isRecord } from "../core/schema.ts";
import { AcpExecutorConfigSchema } from "../executor/acp/executor.ts";

const NonEmpty = z.string().min(1);

/** Peer addresses in canonical URL form, deduplicated. */
const PeersSchema = z.array(z.string()).transform((value, ctx) => {
  try {
    return [...new Set(value.map((peer) => normalizePeerUrl(peer)))];
  } catch (error) {
    ctx.addIssue({ code: "custom", message: errorMessage(error) });
    return z.NEVER;
  }
});

/**
 * Every setting a node has: a field with a default is always present after
 * parsing, the others may be absent. The task and model settings are declared
 * where they are read (`TaskSettingsSchema`, `ModelSettingsSchema`), so the
 * parsed settings can be handed to those subsystems as they are.
 */
const SettingsSchema = z.object({
  /** Unset until the panel wizard picks one. */
  workgroup_id: WorkgroupIdSchema.optional(),
  /** Defaults to the shortened orca node id. */
  display_name: NonEmpty.optional(),
  /** Listen address; `127.0.0.1` keeps a fresh install local until an interface is chosen. */
  bind_host: NonEmpty.default("127.0.0.1"),
  /** Listen port; 0 picks a free one. */
  port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
  /** Advertised dial URLs, best first; empty derives them from the listen address (§3.2). */
  endpoints: EndpointsSchema.default([]),
  /** Peers joined on startup. */
  peers: PeersSchema.default([]),
  /**
   * Who may call this node and which nodes it may call (§6.5): the default for
   * peers without an entry, and per-node overrides. `allow` everywhere keeps a
   * flat mesh, which is what an install that never opens this setting has.
   */
  trust: TrustSettingsSchema.prefault({}),
  acp: AcpExecutorConfigSchema.optional(),
  ...TaskSettingsSchema.shape,
  ...ModelSettingsSchema.shape,
});

export type Settings = z.output<typeof SettingsSchema>;

const { shape } = SettingsSchema;

/** A panel field: a value sets the setting, `null` clears it back to its default. */
function clearable<T extends z.ZodType>(schema: T) {
  return schema.nullable().optional();
}

/**
 * A panel edit: the settings the panel may set, checked one by one with the
 * setting's own schema (the merged result is checked again as a whole by
 * `parseSettings`), and the workgroup password, which goes to the credential
 * store and never to the settings file. Other keys are dropped.
 */
export const PanelPatchSchema = z.object({
  workgroup_id: clearable(shape.workgroup_id.unwrap()),
  /**
   * Plaintext; it derives the workgroup key. The stored password is a DSH credential
   * (§3.6). Leave it out to keep the stored one; a passwordless mesh is not supported.
   */
  workgroup_password: z
    .string()
    .trim()
    .min(1, "a workgroup password is required; a passwordless mesh is not supported")
    .optional(),
  display_name: clearable(shape.display_name.unwrap()),
  bind_host: clearable(shape.bind_host.unwrap()),
  port: clearable(shape.port.unwrap()),
  endpoints: clearable(shape.endpoints.unwrap()),
  /** Whole-setting replacement: `null` clears every override back to "allow" (§6.5). */
  trust: clearable(shape.trust.unwrap()),
  permission_mode: clearable(shape.permission_mode.unwrap()),
  task_timeout_s: clearable(shape.task_timeout_s.unwrap()),
  max_workspace_bytes: clearable(shape.max_workspace_bytes.unwrap()),
  default_reasoning_effort: clearable(shape.default_reasoning_effort.unwrap()),
});

export type PanelPatch = z.output<typeof PanelPatchSchema>;

/**
 * Parse untrusted settings (the settings file, a file a panel patch was applied
 * to). `undefined` and `null` both mean "unset": the default applies, so a panel
 * patch clears a field by sending `null`. Unknown keys are dropped; every
 * invalid value is reported with its path.
 */
export function parseSettings(input: unknown): Settings {
  const set = isRecord(input) ? Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null)) : input;
  const result = SettingsSchema.safeParse(set);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`);
  throw new HarnessError(`invalid config: ${problems.join("; ")}`, "INVALID_CONFIG");
}
