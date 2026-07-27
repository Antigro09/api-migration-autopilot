import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import type { TenantContext } from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import { emitTelemetry } from "@/lib/telemetry";
import { readRunArtifact } from "./artifacts";
import { appendAuditEvent } from "./control-plane";

const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MIN_GRANT_MINUTES = 30;
const MAX_GRANT_MINUTES = 24 * 60;
const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const SUPPORT_ARTIFACT_KINDS = new Set([
  "repository_archive",
  "affected_snippets",
  "patch",
  "patch_file",
  "validation_log",
]);

export type CustomerSupportRequest = {
  id: string;
  runId: string;
  reason: string;
  requestedDurationMinutes: number;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
};

export type CustomerSupportGrant = {
  id: string;
  runId: string;
  reason: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  active: boolean;
};

export type CustomerSupportAccess = {
  requests: CustomerSupportRequest[];
  grants: CustomerSupportGrant[];
};

export type OperationsSupportRequest = CustomerSupportRequest & {
  organizationId: string;
};

export type OperationsSupportArtifact = {
  artifactId: string;
  runId: string;
  kind: string;
  sizeBytes: number;
  expiresAt: string | null;
  grantId: string;
  grantExpiresAt: string;
};

export type OperationsSupportAccess = {
  requests: OperationsSupportRequest[];
  activeGrantCount: number;
  activeRunIds: string[];
  artifacts: OperationsSupportArtifact[];
};

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function assertIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new DomainError("VALIDATION_FAILED", `${label} is invalid.`);
  }
}

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

function assertCustomerApprover(tenant: TenantContext): void {
  if (
    tenant.organizationKind !== "customer" ||
    !["admin", "approver"].includes(tenant.role)
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "A customer admin or approver is required.",
    );
  }
}

function validateReason(reasonValue: string): string {
  const reason = reasonValue.trim();
  if (reason.length < 16 || reason.length > 500) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Support purpose must be between 16 and 500 characters.",
    );
  }
  return reason;
}

function validateDuration(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_GRANT_MINUTES ||
    value > MAX_GRANT_MINUTES
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Support access must be requested for 30 minutes to 24 hours.",
    );
  }
  return value;
}

export async function requestSupportAccess(input: {
  tenant: TenantContext;
  runId: string;
  reason: string;
  durationMinutes: number;
}): Promise<{ requestId: string }> {
  await ensureDatabaseSchema();
  assertInternalOperator(input.tenant);
  assertIdentifier(input.runId, "Run ID");
  const reason = validateReason(input.reason);
  const duration = validateDuration(input.durationMinutes);
  const database = getD1();
  const run = await database
    .prepare(
      `SELECT organization_id AS organizationId
       FROM migration_runs WHERE id = ? LIMIT 1`,
    )
    .bind(input.runId)
    .first<{ organizationId: string }>();
  if (!run) throw new DomainError("NOT_FOUND", "The run was not found.");

  const existing = await database
    .prepare(
      `SELECT id, status
       FROM support_access_requests
       WHERE run_id = ? AND requested_by_membership_id = ?
         AND status = 'pending'
       LIMIT 1`,
    )
    .bind(input.runId, input.tenant.membershipId)
    .first<{ id: string; status: string }>();
  if (existing) return { requestId: existing.id };
  const active = await database
    .prepare(
      `SELECT id
       FROM support_access_grants
       WHERE run_id = ? AND granted_to_membership_id = ?
         AND revoked_at IS NULL AND expires_at > ?
       LIMIT 1`,
    )
    .bind(input.runId, input.tenant.membershipId, new Date().toISOString())
    .first<{ id: string }>();
  if (active) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "An active support grant already covers this run.",
    );
  }

  const requestId = id("sar");
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO support_access_requests (
        id, organization_id, run_id, requested_by_membership_id,
        reason, requested_duration_minutes, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .bind(
      requestId,
      run.organizationId,
      input.runId,
      input.tenant.membershipId,
      reason,
      duration,
      now,
      now,
    )
    .run();
  await appendAuditEvent({
    organizationId: run.organizationId,
    aggregateType: "support_request",
    aggregateId: requestId,
    action: "support.access_requested",
    actorMembershipId: input.tenant.membershipId,
    payload: {
      runId: input.runId,
      requestedDurationMinutes: duration,
      reason,
      internalOrganizationId: input.tenant.organizationId,
    },
  });
  await emitTelemetry({
    name: "support.access_changed",
    organizationId: run.organizationId,
    runId: input.runId,
    metadata: {
      operation: "support_requested",
      outcome: "started",
    },
  }).catch(() => undefined);
  return { requestId };
}

export async function cancelSupportAccessRequest(input: {
  tenant: TenantContext;
  requestId: string;
}): Promise<void> {
  await ensureDatabaseSchema();
  assertInternalOperator(input.tenant);
  assertIdentifier(input.requestId, "Support request ID");
  const now = new Date().toISOString();
  const request = await getD1()
    .prepare(
      `SELECT organization_id AS organizationId
       FROM support_access_requests
       WHERE id = ? AND requested_by_membership_id = ? AND status = 'pending'
       LIMIT 1`,
    )
    .bind(input.requestId, input.tenant.membershipId)
    .first<{ organizationId: string }>();
  if (!request) {
    throw new DomainError(
      "NOT_FOUND",
      "The pending support request was not found.",
    );
  }
  const changed = await getD1()
    .prepare(
      `UPDATE support_access_requests
       SET status = 'cancelled', resolved_at = ?, updated_at = ?
       WHERE id = ? AND requested_by_membership_id = ? AND status = 'pending'`,
    )
    .bind(now, now, input.requestId, input.tenant.membershipId)
    .run();
  if (changed.meta.changes !== 1) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The request changed before it could be cancelled.",
    );
  }
  await appendAuditEvent({
    organizationId: request.organizationId,
    aggregateType: "support_request",
    aggregateId: input.requestId,
    action: "support.request_cancelled",
    actorMembershipId: input.tenant.membershipId,
    payload: { internalOrganizationId: input.tenant.organizationId },
  });
}

export async function resolveSupportAccessRequest(input: {
  tenant: TenantContext;
  requestId: string;
  decision: "approve" | "deny";
}): Promise<{ grantId: string | null }> {
  await ensureDatabaseSchema();
  assertCustomerApprover(input.tenant);
  assertIdentifier(input.requestId, "Support request ID");
  const database = getD1();
  const request = await database
    .prepare(
      `SELECT
         sar.organization_id AS organizationId,
         sar.run_id AS runId,
         sar.requested_by_membership_id AS requestedByMembershipId,
         sar.reason,
         sar.requested_duration_minutes AS requestedDurationMinutes,
         sar.status,
         sar.created_at AS createdAt,
         m.status AS requesterStatus,
         o.kind AS requesterOrganizationKind
       FROM support_access_requests sar
       JOIN memberships m ON m.id = sar.requested_by_membership_id
       JOIN organizations o ON o.id = m.organization_id
       WHERE sar.id = ? AND sar.organization_id = ?
       LIMIT 1`,
    )
    .bind(input.requestId, input.tenant.organizationId)
    .first<{
      organizationId: string;
      runId: string;
      requestedByMembershipId: string;
      reason: string;
      requestedDurationMinutes: number;
      status: string;
      createdAt: string;
      requesterStatus: string;
      requesterOrganizationKind: string;
    }>();
  if (!request) {
    throw new DomainError("NOT_FOUND", "The support request was not found.");
  }
  if (request.status !== "pending") {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "The support request has already been resolved.",
    );
  }
  const nowDate = new Date();
  const now = nowDate.toISOString();
  if (Date.parse(request.createdAt) + REQUEST_TTL_MS <= nowDate.getTime()) {
    await database
      .prepare(
        `UPDATE support_access_requests
         SET status = 'expired', resolved_at = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'pending'`,
      )
      .bind(now, now, input.requestId, input.tenant.organizationId)
      .run();
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "The support request expired after seven days.",
    );
  }

  if (input.decision === "deny") {
    const changed = await database
      .prepare(
        `UPDATE support_access_requests
         SET status = 'denied', resolved_by_membership_id = ?,
             resolved_at = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'pending'`,
      )
      .bind(
        input.tenant.membershipId,
        now,
        now,
        input.requestId,
        input.tenant.organizationId,
      )
      .run();
    if (changed.meta.changes !== 1) {
      throw new DomainError(
        "CONCURRENT_MODIFICATION",
        "The support request changed before it could be denied.",
      );
    }
    await appendAuditEvent({
      organizationId: input.tenant.organizationId,
      aggregateType: "support_request",
      aggregateId: input.requestId,
      action: "support.access_denied",
      actorMembershipId: input.tenant.membershipId,
      payload: { runId: request.runId },
    });
    await emitTelemetry({
      name: "support.access_changed",
      organizationId: input.tenant.organizationId,
      runId: request.runId,
      metadata: {
        operation: "support_denied",
        outcome: "rejected",
      },
    }).catch(() => undefined);
    return { grantId: null };
  }

  if (
    request.requesterStatus !== "active" ||
    request.requesterOrganizationKind !== "internal"
  ) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "The requesting support operator is no longer active.",
    );
  }
  const durationMinutes = validateDuration(
    Number(request.requestedDurationMinutes),
  );
  const grantId = id("sag");
  const expiresAt = new Date(
    nowDate.getTime() + durationMinutes * 60_000,
  ).toISOString();
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO support_access_grants (
          id, organization_id, run_id, granted_to_membership_id,
          granted_by_membership_id, reason, expires_at, created_at
        )
        SELECT ?, organization_id, run_id, requested_by_membership_id,
               ?, reason, ?, ?
        FROM support_access_requests
        WHERE id = ? AND organization_id = ? AND status = 'pending'`,
      )
      .bind(
        grantId,
        input.tenant.membershipId,
        expiresAt,
        now,
        input.requestId,
        input.tenant.organizationId,
      ),
    database
      .prepare(
        `UPDATE support_access_requests
         SET status = 'approved', resolved_by_membership_id = ?,
             grant_id = ?, resolved_at = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'pending'
           AND EXISTS (
             SELECT 1 FROM support_access_grants sag WHERE sag.id = ?
           )`,
      )
      .bind(
        input.tenant.membershipId,
        grantId,
        now,
        now,
        input.requestId,
        input.tenant.organizationId,
        grantId,
      ),
  ]);
  if (
    Number(results[0]?.meta.changes ?? 0) !== 1 ||
    Number(results[1]?.meta.changes ?? 0) !== 1
  ) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The support request changed before it could be approved.",
    );
  }
  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "support_request",
    aggregateId: input.requestId,
    action: "support.access_approved",
    actorMembershipId: input.tenant.membershipId,
    payload: {
      grantId,
      runId: request.runId,
      expiresAt,
      reason: request.reason,
    },
  });
  await emitTelemetry({
    name: "support.access_changed",
    organizationId: input.tenant.organizationId,
    runId: request.runId,
    metadata: {
      operation: "support_approved",
      outcome: "succeeded",
      duration_ms: durationMinutes * 60_000,
    },
  }).catch(() => undefined);
  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "support_grant",
    aggregateId: grantId,
    action: "support.grant_created",
    actorMembershipId: input.tenant.membershipId,
    payload: {
      requestId: input.requestId,
      runId: request.runId,
      expiresAt,
    },
  });
  return { grantId };
}

export async function revokeSupportAccessGrant(input: {
  tenant: TenantContext;
  grantId: string;
}): Promise<void> {
  await ensureDatabaseSchema();
  assertCustomerApprover(input.tenant);
  assertIdentifier(input.grantId, "Support grant ID");
  const now = new Date().toISOString();
  const changed = await getD1()
    .prepare(
      `UPDATE support_access_grants
       SET revoked_at = ?
       WHERE id = ? AND organization_id = ? AND revoked_at IS NULL`,
    )
    .bind(now, input.grantId, input.tenant.organizationId)
    .run();
  if (changed.meta.changes !== 1) {
    throw new DomainError(
      "NOT_FOUND",
      "The active support grant was not found.",
    );
  }
  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "support_grant",
    aggregateId: input.grantId,
    action: "support.grant_revoked",
    actorMembershipId: input.tenant.membershipId,
    payload: { revokedAt: now },
  });
}

export async function customerSupportAccess(
  organizationId: string,
): Promise<CustomerSupportAccess> {
  await ensureDatabaseSchema();
  const database = getD1();
  const [requests, grants] = await Promise.all([
    database
      .prepare(
        `SELECT
           id, run_id AS runId, reason,
           requested_duration_minutes AS requestedDurationMinutes,
           status, created_at AS createdAt, resolved_at AS resolvedAt
         FROM support_access_requests
         WHERE organization_id = ?
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .bind(organizationId)
      .all<CustomerSupportRequest>(),
    database
      .prepare(
        `SELECT
           id, run_id AS runId, reason, expires_at AS expiresAt,
           revoked_at AS revokedAt, created_at AS createdAt
         FROM support_access_grants
         WHERE organization_id = ?
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .bind(organizationId)
      .all<Omit<CustomerSupportGrant, "active">>(),
  ]);
  const now = Date.now();
  return {
    requests: requests.results.map((request) => ({
      ...request,
      requestedDurationMinutes: Number(request.requestedDurationMinutes),
    })),
    grants: grants.results.map((grant) => ({
      ...grant,
      active: !grant.revokedAt && Date.parse(grant.expiresAt) > now,
    })),
  };
}

export async function operationsSupportAccess(
  tenant: TenantContext,
): Promise<OperationsSupportAccess> {
  await ensureDatabaseSchema();
  assertInternalOperator(tenant);
  const database = getD1();
  const now = new Date().toISOString();
  const [requests, activeGrants, artifacts] = await Promise.all([
    database
      .prepare(
        `SELECT
           id, organization_id AS organizationId, run_id AS runId, reason,
           requested_duration_minutes AS requestedDurationMinutes,
           status, created_at AS createdAt, resolved_at AS resolvedAt
         FROM support_access_requests
         WHERE requested_by_membership_id = ?
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .bind(tenant.membershipId)
      .all<OperationsSupportRequest>(),
    database
      .prepare(
        `SELECT run_id AS runId
         FROM support_access_grants
         WHERE granted_to_membership_id = ?
           AND revoked_at IS NULL AND expires_at > ?
         ORDER BY expires_at ASC
         LIMIT 100`,
      )
      .bind(tenant.membershipId, now)
      .all<{ runId: string }>(),
    database
      .prepare(
        `SELECT
           a.id AS artifactId,
           a.run_id AS runId,
           a.kind,
           a.size_bytes AS sizeBytes,
           a.expires_at AS expiresAt,
           sag.id AS grantId,
           sag.expires_at AS grantExpiresAt
         FROM support_access_grants sag
         JOIN artifacts a
           ON a.organization_id = sag.organization_id
          AND a.run_id = sag.run_id
         WHERE sag.granted_to_membership_id = ?
           AND sag.revoked_at IS NULL
           AND sag.expires_at > ?
           AND a.lifecycle_state = 'active'
           AND (a.expires_at IS NULL OR a.expires_at > ?)
           AND a.kind IN (
             'repository_archive', 'affected_snippets', 'patch',
             'patch_file', 'validation_log'
           )
         ORDER BY sag.expires_at ASC, a.created_at ASC
         LIMIT 100`,
      )
      .bind(tenant.membershipId, now, now)
      .all<OperationsSupportArtifact>(),
  ]);
  return {
    requests: requests.results.map((request) => ({
      ...request,
      requestedDurationMinutes: Number(request.requestedDurationMinutes),
    })),
    activeGrantCount: activeGrants.results.length,
    activeRunIds: [...new Set(activeGrants.results.map((grant) => grant.runId))],
    artifacts: artifacts.results.map((artifact) => ({
      ...artifact,
      sizeBytes: Number(artifact.sizeBytes),
    })),
  };
}

export async function readSupportArtifact(input: {
  tenant: TenantContext;
  artifactId: string;
}): Promise<{
  plaintext: string;
  kind: string;
  sizeBytes: number;
  grantExpiresAt: string;
}> {
  await ensureDatabaseSchema();
  assertInternalOperator(input.tenant);
  assertIdentifier(input.artifactId, "Artifact ID");
  const now = new Date().toISOString();
  const access = await getD1()
    .prepare(
      `SELECT
         a.organization_id AS organizationId,
         a.run_id AS runId,
         a.kind,
         a.size_bytes AS sizeBytes,
         sag.id AS grantId,
         sag.expires_at AS grantExpiresAt
       FROM artifacts a
       JOIN support_access_grants sag
         ON sag.organization_id = a.organization_id
        AND sag.run_id = a.run_id
       JOIN memberships m ON m.id = sag.granted_to_membership_id
       WHERE a.id = ?
         AND sag.granted_to_membership_id = ?
         AND m.status = 'active'
         AND sag.revoked_at IS NULL
         AND sag.expires_at > ?
         AND a.lifecycle_state = 'active'
         AND (a.expires_at IS NULL OR a.expires_at > ?)
       ORDER BY sag.expires_at DESC
       LIMIT 1`,
    )
    .bind(input.artifactId, input.tenant.membershipId, now, now)
    .first<{
      organizationId: string;
      runId: string;
      kind: string;
      sizeBytes: number;
      grantId: string;
      grantExpiresAt: string;
    }>();
  if (!access || !SUPPORT_ARTIFACT_KINDS.has(access.kind)) {
    throw new DomainError(
      "NOT_FOUND",
      "No active customer grant permits access to this artifact.",
    );
  }
  const plaintext = await readRunArtifact({
    organizationId: access.organizationId,
    artifactId: input.artifactId,
  });
  await appendAuditEvent({
    organizationId: access.organizationId,
    aggregateType: "support_grant",
    aggregateId: access.grantId,
    action: "support.artifact_read",
    actorMembershipId: input.tenant.membershipId,
    payload: {
      artifactId: input.artifactId,
      runId: access.runId,
      artifactKind: access.kind,
      sizeBytes: Number(access.sizeBytes),
      internalOrganizationId: input.tenant.organizationId,
    },
  });
  await emitTelemetry({
    name: "support.artifact_read",
    organizationId: access.organizationId,
    runId: access.runId,
    metadata: {
      artifact_kind: access.kind,
      byte_count: Number(access.sizeBytes),
      outcome: "succeeded",
    },
  }).catch(() => undefined);
  return {
    plaintext,
    kind: access.kind,
    sizeBytes: Number(access.sizeBytes),
    grantExpiresAt: access.grantExpiresAt,
  };
}
