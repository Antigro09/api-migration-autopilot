import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import type { TenantContext } from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import {
  emitTelemetry,
  type TelemetryEventName,
} from "@/lib/telemetry";
import { appendAuditEvent } from "./control-plane";

const SAFE_CODE = /^[a-z][a-z0-9._-]{2,127}$/;

export type OperationalAlert = {
  id: string;
  organizationId: string | null;
  runId: string | null;
  severity: "warning" | "critical";
  code: string;
  status: "open" | "acknowledged" | "resolved";
  occurrenceCount: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
};

function assertInternalOperator(tenant: TenantContext): void {
  if (
    tenant.organizationKind !== "internal" ||
    !["admin", "operator"].includes(tenant.role)
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "An internal admin or operator is required.",
    );
  }
}

function assertAlertCode(code: string): void {
  if (!SAFE_CODE.test(code)) {
    throw new DomainError("VALIDATION_FAILED", "Alert code is invalid.");
  }
}

export async function recordOperationalAlert(input: {
  organizationId?: string;
  runId?: string;
  severity: "warning" | "critical";
  code: string;
  eventName: TelemetryEventName;
  metadata?: Readonly<Record<string, unknown>>;
}): Promise<{ alertId: string }> {
  await ensureDatabaseSchema();
  assertAlertCode(input.code);
  const database = getD1();
  const now = new Date().toISOString();
  const existing = await database
    .prepare(
      `SELECT id
       FROM operational_alerts
       WHERE code = ?
         AND COALESCE(organization_id, '') = COALESCE(?, '')
         AND COALESCE(run_id, '') = COALESCE(?, '')
         AND status IN ('open', 'acknowledged')
       ORDER BY last_occurred_at DESC
       LIMIT 1`,
    )
    .bind(input.code, input.organizationId ?? null, input.runId ?? null)
    .first<{ id: string }>();
  const alertId =
    existing?.id ?? `opa_${crypto.randomUUID().replaceAll("-", "")}`;
  if (existing) {
    await database
      .prepare(
        `UPDATE operational_alerts
         SET severity = ?,
             status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
             occurrence_count = occurrence_count + 1,
             last_occurred_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(input.severity, now, now, alertId)
      .run();
  } else {
    await database
      .prepare(
        `INSERT INTO operational_alerts (
          id, organization_id, run_id, severity, code, status,
          occurrence_count, first_occurred_at, last_occurred_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?)`,
      )
      .bind(
        alertId,
        input.organizationId ?? null,
        input.runId ?? null,
        input.severity,
        input.code,
        now,
        now,
        now,
        now,
      )
      .run();
  }
  await emitTelemetry({
    name: input.eventName,
    organizationId: input.organizationId,
    runId: input.runId,
    metadata: {
      ...input.metadata,
      severity: input.severity,
      alert_code: input.code,
    },
  }).catch(() => undefined);
  return { alertId };
}

export async function listOperationalAlerts(
  tenant: TenantContext,
): Promise<OperationalAlert[]> {
  await ensureDatabaseSchema();
  assertInternalOperator(tenant);
  const rows = await getD1()
    .prepare(
      `SELECT
         id,
         organization_id AS organizationId,
         run_id AS runId,
         severity,
         code,
         status,
         occurrence_count AS occurrenceCount,
         first_occurred_at AS firstOccurredAt,
         last_occurred_at AS lastOccurredAt,
         acknowledged_at AS acknowledgedAt,
         resolved_at AS resolvedAt
       FROM operational_alerts
       WHERE status != 'resolved'
       ORDER BY
         CASE severity WHEN 'critical' THEN 0 ELSE 1 END,
         last_occurred_at DESC
       LIMIT 100`,
    )
    .all<OperationalAlert>();
  return rows.results.map((alert) => ({
    ...alert,
    occurrenceCount: Number(alert.occurrenceCount),
  }));
}

export async function changeOperationalAlert(input: {
  tenant: TenantContext;
  alertId: string;
  action: "acknowledge" | "resolve";
}): Promise<void> {
  await ensureDatabaseSchema();
  assertInternalOperator(input.tenant);
  if (!/^opa_[a-f0-9]{32}$/.test(input.alertId)) {
    throw new DomainError("VALIDATION_FAILED", "Alert ID is invalid.");
  }
  const database = getD1();
  const alert = await database
    .prepare(
      `SELECT organization_id AS organizationId, run_id AS runId, status, code
       FROM operational_alerts WHERE id = ? LIMIT 1`,
    )
    .bind(input.alertId)
    .first<{
      organizationId: string | null;
      runId: string | null;
      status: string;
      code: string;
    }>();
  if (!alert) throw new DomainError("NOT_FOUND", "Alert not found.");
  if (alert.status === "resolved") return;
  const now = new Date().toISOString();
  const result =
    input.action === "acknowledge"
      ? await database
          .prepare(
            `UPDATE operational_alerts
             SET status = 'acknowledged',
                 acknowledged_by_membership_id = ?,
                 acknowledged_at = ?, updated_at = ?
             WHERE id = ? AND status = 'open'`,
          )
          .bind(input.tenant.membershipId, now, now, input.alertId)
          .run()
      : await database
          .prepare(
            `UPDATE operational_alerts
             SET status = 'resolved', resolved_at = ?, updated_at = ?
             WHERE id = ? AND status IN ('open', 'acknowledged')`,
          )
          .bind(now, now, input.alertId)
          .run();
  if (result.meta.changes !== 1 && input.action === "acknowledge") {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The alert changed before it could be acknowledged.",
    );
  }
  if (alert.organizationId) {
    await appendAuditEvent({
      organizationId: alert.organizationId,
      aggregateType: "operational_alert",
      aggregateId: input.alertId,
      action: `operations.alert_${input.action}d`,
      actorMembershipId: input.tenant.membershipId,
      payload: {
        code: alert.code,
        runId: alert.runId,
        internalOrganizationId: input.tenant.organizationId,
      },
    });
  }
}
