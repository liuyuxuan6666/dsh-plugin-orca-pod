import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import { PodError } from "../core/errors.ts";
import { isRecord } from "../core/schema.ts";
import type { OrcaNodeId } from "../core/ids.ts";
import type { SingleSlotTaskRunner } from "../task/runner.ts";
import { A2ARequestSchema, type TaskView } from "../task/wire.ts";
import { parseInput } from "./input.ts";

/** The methods this node answers; any other is `unsupported`, not a malformed request. */
const METHODS: ReadonlySet<unknown> = new Set(A2ARequestSchema.options.map((option) => option.shape.method.value));

/** The A2A JSON-RPC surface (§4.7): submit, read and cancel tasks. */
export class A2aRoutes {
  constructor(
    private readonly tasks: SingleSlotTaskRunner,
    /** This node: the one caller besides a task's origin that may read it. */
    private readonly selfOrcaNodeId: OrcaNodeId,
  ) {}

  register(app: FastifyInstance): void {
    app.post("/a2a", { config: { access: "member", rpc: true } }, async (request) => {
      const { body } = request;
      if (isRecord(body) && typeof body.method === "string" && !METHODS.has(body.method)) {
        throw new PodError("unsupported", `unsupported method ${body.method}`);
      }
      const call = parseInput(A2ARequestSchema, body, "body");
      return {
        jsonrpc: "2.0",
        id: call.id ?? null,
        result: this.dispatch(call, request.auth.orcaNodeId),
      };
    });
  }

  private dispatch(call: z.output<typeof A2ARequestSchema>, caller: OrcaNodeId): TaskView {
    switch (call.method) {
      case "message/send": {
        // The schema checked the message parts and metadata.pod; the runner reads them as typed.
        const { message, metadata } = call.params;
        return message.taskId
          ? this.tasks.resume(message.taskId, message, caller)
          : this.tasks.submit({ message, metadata }, caller);
      }
      case "tasks/get": {
        const { id } = call.params;
        const view = this.tasks.get(id);
        if (!view) throw new PodError("task_not_found", `unknown task ${id}`);
        // Reading used to be open to the whole workgroup, keyed by a task id nobody
        // could guess (§5.5). Only the origin that dispatched the task — and this
        // node itself, whose panel reads its own tasks over this route — may read
        // it now: a peer that may not dispatch cannot use a leaked id to read the
        // result of somebody else's task either.
        const origin = view.metadata?.pod?.origin_orca_node;
        if (caller !== origin && caller !== this.selfOrcaNodeId) {
          throw new PodError("not_task_origin", `task ${id} belongs to another origin`);
        }
        return view;
      }
      case "tasks/cancel":
        return this.tasks.cancel(call.params.id, caller);
    }
  }
}
