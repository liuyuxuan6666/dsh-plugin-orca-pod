import { bindUrlHost, isWildcardHost } from "@deepseek-ai/dsh-host-webserver";
import { randomBytes } from "node:crypto";
import {
  cpus,
  networkInterfaces,
  platform as osPlatform,
  release as osRelease,
  totalmem,
  type NetworkInterfaceInfo,
} from "node:os";
import { join } from "node:path";

import { Gateway } from "../api/gateway.ts";
import { FileBlobRegistry } from "../core/blobs.ts";
import { TrustPolicy } from "../core/trust.ts";

import type { NodeLogger } from "../core/events.ts";
import { shortenNodeId, type NodeIdentity } from "../core/identity.ts";
import { ModelCatalog } from "../executor/model-catalog.ts";
import { SqliteDb } from "../core/sqlite.ts";
import type { RuntimeInfo, SelfDescription } from "../mesh/wire.ts";
import { AcpExecutor } from "../executor/acp/executor.ts";
import type { LocalExecutor } from "../executor/executor.ts";
import { MeshContext, type MeshContextOptions } from "../mesh/context.ts";
import { Mesh } from "../mesh/mesh.ts";
import type { MeshTimings } from "../mesh/timings.ts";
import { DispatchLog } from "../task/dispatch-log.ts";
import { SingleSlotTaskRunner } from "../task/runner.ts";
import { Workspace } from "../task/workspace.ts";
import type { Settings } from "./settings.ts";

/**
 * Where a task session reaches this machine's node, the node's id (the key its
 * TLS certificate must carry), and the token the node's local routes take (§5.6).
 * The node hands them to the executor for the task's environment; the plugin
 * inside the task uses them for the `orca_pod` file methods.
 */
export const NODE_URL_ENV = "ORCA_POD_NODE_URL";
export const NODE_ID_ENV = "ORCA_POD_NODE_ID";
export const NODE_TOKEN_ENV = "ORCA_POD_NODE_TOKEN";

/**
 * The URL a node bound to `host` is dialed at, by DSH's rule for bind literals
 * (`bindUrlHost`: IPv6 bracketed, mapped loopback canonical, host names as
 * they are); undefined when the address has no URL form (an interface zone id).
 * Nodes speak https only (§7.7).
 */
export function bindUrl(host: string, port: number): string | undefined {
  const urlHost = bindUrlHost(host);
  return urlHost === undefined ? undefined : `https://${urlHost}:${port}`;
}

/**
 * Advertised-URL suggestions for the panel wizard and for nodes that listen on
 * a wildcard address: every non-internal IPv4/IPv6 address of this machine on
 * the given port. IPv4 comes first (the reliable LAN path); link-local IPv6
 * (`fe80:` prefix, needs a zone id) is skipped.
 */
export function detectLocalEndpoints(port: number): string[] {
  const external = Object.values(networkInterfaces())
    .flat()
    .filter((address): address is NetworkInterfaceInfo => address !== undefined && !address.internal);
  const ipv4 = external.filter((address) => address.family !== "IPv6");
  const ipv6 = external.filter((address) => address.family === "IPv6" && !/^fe80:/i.test(address.address));
  const urls = [...ipv4, ...ipv6].map((address) => bindUrl(address.address, port));
  return [...new Set(urls.filter((url): url is string => url !== undefined))];
}

type OrcaNodeOptions = {
  runtime?: RuntimeInfo;
  timings?: Partial<MeshTimings>;
  /** Outbound HTTP for peer calls; tests inject packet loss / delay / partitions. */
  fetch?: MeshContextOptions["fetch"];
  /** Executor override (tests run scripted ones); defaults to the ACP executor (§6.14). */
  executor?: LocalExecutor;
  /** Where refusals and drops are reported; silent unless the entry point supplies one. */
  logger?: NodeLogger;
};

const SILENT: NodeLogger = { warn() {} };

/**
 * The orca instance of this process: the one place that builds the subsystems,
 * wires them to each other and publishes them as read-only fields. The mesh is
 * the way in to every node, this one included (`orca.mesh.self`,
 * `orca.mesh.resolve(ref).sendTask(…)`); the instance itself keeps only what
 * spans them.
 *
 * Building one is cheap and quiet: nothing touches the disk or the network
 * until `start()`.
 */
export class Orca {
  /** The model routes this node offers and the default a task gets (§6.15). */
  readonly models: ModelCatalog;
  /** The node table; this node is a row of it. */
  readonly mesh: Mesh;
  /** What this node handed to other nodes, and what it last heard of each task (§8.3). */
  readonly dispatches: DispatchLog;
  /** Tasks this node runs for others. */
  readonly tasks: SingleSlotTaskRunner;
  /** Workspace directories, for UI browsing. */
  readonly workspace: Workspace;
  /** Who may call this node, and which nodes this one may call (§6.5). */
  readonly trust: TrustPolicy;
  /** The files this node published (§5.6): the `orca_pod` tool publishes into it, members fetch from the gateway. */
  private readonly blobs: FileBlobRegistry;

  private readonly executor: LocalExecutor;

  /** What this machine's processes (a task session) show the local routes; it lives as long as this instance (§5.6). */
  private readonly localToken = randomBytes(32).toString("base64url");
  /** Where a process on this machine dials this node; known once it listens. */
  private localUrl: string | null = null;
  /** The port the node listens on; known once it listens (a configured 0 picks one). */
  private listening: number | null = null;
  /** The one database of the data root (§5.5): tasks, published files and dispatches; `start()` opens it. */
  private readonly db: SqliteDb;
  private readonly gateway: Gateway;
  /** What the nodes of the table share; it holds this node's outbound TLS connections. */
  private readonly context: MeshContext;
  private readonly runtime: RuntimeInfo;

  constructor(
    /** What the node runs with; the settings must name a workgroup. */
    private readonly settings: Settings,
    /** Who this node is: its private key signs every request (§7.1). */
    private readonly identity: NodeIdentity,
    /** The workgroup key, derived from the password; it lives in memory only (§7.1). */
    key: Buffer,
    /** Where the node keeps its database, workspaces and published files (§3.9). */
    dataRoot: string,
    options: OrcaNodeOptions = {},
  ) {
    const workgroupId = settings.workgroup_id;
    if (workgroupId === undefined) throw new Error("workgroup_id is required");
    const logger = options.logger ?? SILENT;
    this.db = new SqliteDb(join(dataRoot, "tasks.db"));
    this.blobs = new FileBlobRegistry(this.db, join(dataRoot, "blobs"));
    this.workspace = new Workspace(dataRoot, workgroupId);
    this.runtime = options.runtime ?? Orca.collectRuntime();

    this.models = new ModelCatalog(settings, logger);
    this.dispatches = new DispatchLog(this.db);
    this.executor =
      options.executor ??
      new AcpExecutor(settings.acp ?? {}, this.models, logger, {
        // The task's plugin reaches this node through its local routes (§5.6).
        env: (): Record<string, string> =>
          this.localUrl === null
            ? {}
            : {
                [NODE_URL_ENV]: this.localUrl,
                [NODE_ID_ENV]: identity.orcaNodeId,
                [NODE_TOKEN_ENV]: this.localToken,
              },
      });
    this.tasks = new SingleSlotTaskRunner(
      this.executor,
      this.db,
      this.workspace,
      settings,
      identity.orcaNodeId,
      logger,
    );
    this.trust = new TrustPolicy(settings.trust, identity.orcaNodeId);
    this.context = new MeshContext(
      identity,
      workgroupId,
      key,
      this.dispatches,
      this.blobs,
      this.tasks,
      this.trust,
      logger,
      {
        fetch: options.fetch,
      },
    );
    this.mesh = new Mesh(this.context, this.describeSelf(Orca.endpointsFrom(settings, settings.port)), {
      timings: options.timings,
    });
    this.gateway = new Gateway(
      this.mesh,
      this.tasks,
      workgroupId,
      key,
      identity,
      this.localToken,
      this.workspace.root,
      this.trust,
    );

    // A new catalog changes what this node announces about itself (§6.15).
    this.models.changes.subscribe(() => this.mesh.self.describe(this.describeSelf(this.mesh.self.endpoints)));
  }

  /**
   * Bind the listener and start the heartbeat; resolves with the URL peers should dial.
   *
   * Binding the port comes first, and nothing that touches the data root happens
   * before it: the port is the lock that keeps a second process on this machine
   * (another DSH with the same plugin) from recovering the tasks and dispatches
   * of the one that is running (§3.9). The database is opened, and the
   * interrupted work failed, in the same turn the bind completes in, so no
   * request can reach a store that is not open.
   */
  async start(): Promise<{ url: string; port: number }> {
    const address = await this.gateway.listen(this.settings.bind_host, this.settings.port);
    this.db.open();
    this.blobs.start();
    this.workspace.ensure();
    this.tasks.start();
    this.dispatches.markInFlightUnknown();
    const port = Number(new URL(address).port);
    this.listening = port;
    this.localUrl = Orca.localUrlOf(this.settings.bind_host, port);
    const urls = Orca.endpointsFrom(this.settings, port);
    this.mesh.self.describe(this.describeSelf(urls));
    this.mesh.start();
    return { url: urls[0], port };
  }

  /** The port the node listens on, or the configured one before it does. */
  get port(): number {
    return this.listening ?? this.settings.port;
  }

  async stop(): Promise<void> {
    this.blobs.stop();
    this.mesh.stop();
    await this.gateway.close();
    await this.context.close();
    await this.executor.close?.();
    this.db.close();
  }

  /**
   * Where a process on this machine dials a node bound to `host`: loopback for a
   * wildcard bind, else the bound address (a connection from this machine to its
   * own address, which the local routes accept, §5.6).
   */
  private static localUrlOf(host: string, port: number): string {
    return (isWildcardHost(host) ? undefined : bindUrl(host, port)) ?? `https://127.0.0.1:${port}`;
  }

  /** What this node says about itself (§2.5, §3.3): who it is, where it can be dialed, what it runs on, which models it offers. */
  private describeSelf(endpoints: readonly string[]): SelfDescription {
    const offers = this.models.offers();
    const defaults = this.models.defaults();
    return {
      // A fresh node with no display name shows its shortened id (§9.2 wizard default).
      display_name: this.settings.display_name ?? shortenNodeId(this.identity.orcaNodeId),
      endpoints: [...endpoints],
      runtime: this.runtime,
      max_task_ttl_s: this.settings.task_timeout_s,
      ...(offers.length > 0 ? { models: offers } : {}),
      default_model: defaults.model,
      default_reasoning_effort: defaults.reasoningEffort,
    };
  }

  /** Snapshot of the local runtime, used to advertise what this machine can do. */
  private static collectRuntime(): RuntimeInfo {
    const platform = osPlatform();
    const processors = cpus();
    return {
      os: {
        family: platform,
        name: platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform,
        version: osRelease(),
      },
      arch: process.arch,
      cpu: {
        model: processors[0]?.model ?? "unknown",
        logical_cores: processors.length,
      },
      memory: { total_bytes: totalmem() },
      node: { version: process.version },
      captured_at: new Date().toISOString(),
    };
  }

  /** Addresses a remote orca node should dial: explicit list, else derived from bind. */
  private static endpointsFrom(settings: Settings, port: number): [string, ...string[]] {
    const [first, ...rest] = settings.endpoints;
    if (first !== undefined) return [first, ...rest];
    if (!isWildcardHost(settings.bind_host)) {
      const url = bindUrl(settings.bind_host, port);
      if (url !== undefined) return [url];
    }
    const [firstDetected, ...restDetected] = detectLocalEndpoints(port);
    return firstDetected === undefined ? [`https://127.0.0.1:${port}`] : [firstDetected, ...restDetected];
  }
}
