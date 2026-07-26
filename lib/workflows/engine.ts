import { requireSecret } from "@/lib/platform/config";

export type WorkflowTrigger<TPayload extends Record<string, unknown>> = {
  task: string;
  payload: TPayload;
  idempotencyKey: string;
  concurrencyKey: string;
};

export type WorkflowRun = {
  id: string;
  task: string;
};

export interface WorkflowEngine {
  trigger<TPayload extends Record<string, unknown>>(
    command: WorkflowTrigger<TPayload>,
  ): Promise<WorkflowRun>;
}

const SAFE_TASK_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export class TriggerWorkflowEngine implements WorkflowEngine {
  async trigger<TPayload extends Record<string, unknown>>(
    command: WorkflowTrigger<TPayload>,
  ): Promise<WorkflowRun> {
    if (!SAFE_TASK_IDENTIFIER.test(command.task)) {
      throw new Error("Invalid workflow task identifier.");
    }
    if (!command.idempotencyKey || !command.concurrencyKey) {
      throw new Error("Durable workflows require idempotency and concurrency keys.");
    }

    const secretKey = requireSecret("TRIGGER_SECRET_KEY");
    const apiUrl = (
      process.env.TRIGGER_API_URL?.trim() || "https://api.trigger.dev"
    ).replace(/\/+$/, "");

    const response = await fetch(
      `${apiUrl}/api/v1/tasks/${encodeURIComponent(command.task)}/trigger`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          payload: command.payload,
          options: {
            idempotencyKey: command.idempotencyKey,
            concurrencyKey: command.concurrencyKey,
          },
        }),
      },
    );

    const result = (await response.json().catch(() => null)) as
      | { id?: unknown; error?: unknown }
      | null;
    if (!response.ok || typeof result?.id !== "string") {
      const detail =
        typeof result?.error === "string"
          ? result.error
          : `Trigger.dev returned HTTP ${response.status}.`;
      throw new Error(`Workflow dispatch failed: ${detail}`);
    }

    return { id: result.id, task: command.task };
  }
}
