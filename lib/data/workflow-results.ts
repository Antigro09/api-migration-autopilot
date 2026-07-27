import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import {
  canonicalJson,
  sha256Hex,
  type JsonObject,
  type JsonValue,
} from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";

type ReceiptKind = "assessment" | "patch";

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function resultFingerprint(
  kind: ReceiptKind,
  payload: unknown,
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      schemaVersion: "workflow-result-receipt/1",
      kind,
      payload: jsonValue(payload),
    }),
  );
}

/**
 * Claims one validated workflow result per run. Exact completed replays return
 * the persisted response without invoking `process`; different payloads and
 * concurrent delivery attempts fail closed.
 */
export async function processWorkflowResult<T extends JsonObject>(input: {
  runId: string;
  organizationId: string;
  kind: ReceiptKind;
  payload: unknown;
  process: () => Promise<T>;
  recoverCompleted?: () => Promise<T | null>;
}): Promise<T> {
  await ensureDatabaseSchema();
  const database = getD1();
  const fingerprint = await resultFingerprint(input.kind, input.payload);
  const now = new Date().toISOString();
  const claim = await database
    .prepare(
      `INSERT OR IGNORE INTO workflow_result_receipts (
        run_id, organization_id, kind, fingerprint, status, claimed_at
      ) VALUES (?, ?, ?, ?, 'processing', ?)`,
    )
    .bind(
      input.runId,
      input.organizationId,
      input.kind,
      fingerprint,
      now,
    )
    .run();

  if (Number(claim.meta.changes ?? 0) === 0) {
    const receipt = await database
      .prepare(
        `SELECT organization_id AS organizationId, kind, fingerprint, status,
                response
         FROM workflow_result_receipts
         WHERE run_id = ?
         LIMIT 1`,
      )
      .bind(input.runId)
      .first<{
        organizationId: string;
        kind: string;
        fingerprint: string;
        status: string;
        response: string | T | null;
      }>();
    if (
      !receipt ||
      receipt.organizationId !== input.organizationId ||
      receipt.kind !== input.kind ||
      receipt.fingerprint !== fingerprint
    ) {
      throw new DomainError(
        "CONCURRENT_MODIFICATION",
        "This run already received a different workflow result.",
      );
    }
    if (receipt.status !== "completed" || receipt.response === null) {
      throw new DomainError(
        "CONCURRENT_MODIFICATION",
        "This exact workflow result is already being processed.",
      );
    }
    return (
      typeof receipt.response === "string"
        ? JSON.parse(receipt.response)
        : receipt.response
    ) as T;
  }

  try {
    const response = await input.process();
    await database
      .prepare(
        `UPDATE workflow_result_receipts
         SET status = 'completed', response = ?, completed_at = ?
         WHERE run_id = ? AND organization_id = ? AND kind = ?
           AND fingerprint = ? AND status = 'processing'`,
      )
      .bind(
        JSON.stringify(response),
        new Date().toISOString(),
        input.runId,
        input.organizationId,
        input.kind,
        fingerprint,
      )
      .run();
    return response;
  } catch (error) {
    const recovered = await input.recoverCompleted?.();
    if (recovered) {
      await database
        .prepare(
          `UPDATE workflow_result_receipts
           SET status = 'completed', response = ?, completed_at = ?
           WHERE run_id = ? AND organization_id = ? AND kind = ?
             AND fingerprint = ? AND status = 'processing'`,
        )
        .bind(
          JSON.stringify(recovered),
          new Date().toISOString(),
          input.runId,
          input.organizationId,
          input.kind,
          fingerprint,
        )
        .run();
      return recovered;
    }
    await database
      .prepare(
        `DELETE FROM workflow_result_receipts
         WHERE run_id = ? AND organization_id = ? AND kind = ?
           AND fingerprint = ? AND status = 'processing'`,
      )
      .bind(
        input.runId,
        input.organizationId,
        input.kind,
        fingerprint,
      )
      .run();
    throw error;
  }
}
