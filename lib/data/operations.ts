import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import type { TenantContext } from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import { appendAuditEvent } from "./control-plane";

export type OperationsProviderRecord = {
  organizationId: string;
  name: string;
  verifiedDomain: string | null;
  brandingApprovedAt: string | null;
  createdAt: string;
};

export type OperationsOverviewData = {
  activeRuns: number;
  attentionRuns: number;
  deletionQueue: number;
  unverifiedProviders: number;
  providers: OperationsProviderRecord[];
  recentRuns: Array<{
    id: string;
    kind: string;
    state: string;
    failureCategory: string | null;
    costMicroUsd: number;
    updatedAt: string;
  }>;
  deletionJobs: Array<{
    id: string;
    status: string;
    reason: string;
    attemptCount: number;
    hardDeadlineAt: string;
  }>;
  recentAuditEvents: Array<{
    id: string;
    action: string;
    aggregateType: string;
    aggregateId: string;
    actorMembershipId: string | null;
    occurredAt: string;
  }>;
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

export async function operationsOverview(
  tenant: TenantContext,
): Promise<OperationsOverviewData> {
  await ensureDatabaseSchema();
  assertInternalOperator(tenant);
  const database = getD1();
  const [
    runs,
    deletions,
    providers,
    recentRuns,
    deletionJobs,
    recentAuditEvents,
  ] =
    await Promise.all([
    database
      .prepare(
        `SELECT
           SUM(CASE WHEN state IN (
             'queued', 'acquiring_source', 'analyzing',
             'awaiting_model_consent', 'generating',
             'preparing_dependencies', 'validating', 'publishing',
             'cleanup_pending'
           ) THEN 1 ELSE 0 END) AS activeRuns,
           SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS attentionRuns
         FROM migration_runs`,
      )
      .first<{ activeRuns: number | null; attentionRuns: number | null }>(),
    database
      .prepare(
        `SELECT COUNT(*) AS deletionQueue
         FROM deletion_jobs
         WHERE status IN ('pending', 'running', 'failed')`,
      )
      .first<{ deletionQueue: number }>(),
    database
      .prepare(
        `SELECT
           id AS organizationId,
           name,
           verified_domain AS verifiedDomain,
           provider_branding_approved_at AS brandingApprovedAt,
           created_at AS createdAt
         FROM organizations
         WHERE kind = 'provider'
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .all<OperationsProviderRecord>(),
    database
      .prepare(
        `SELECT
           id, kind, state,
           failure_category AS failureCategory,
           cost_micro_usd AS costMicroUsd,
           updated_at AS updatedAt
         FROM migration_runs
         ORDER BY updated_at DESC
         LIMIT 50`,
      )
      .all<{
        id: string;
        kind: string;
        state: string;
        failureCategory: string | null;
        costMicroUsd: number;
        updatedAt: string;
      }>(),
    database
      .prepare(
        `SELECT
           id, status, reason,
           attempt_count AS attemptCount,
           hard_deadline_at AS hardDeadlineAt
         FROM deletion_jobs
         WHERE status IN ('pending', 'running', 'failed')
         ORDER BY hard_deadline_at ASC
         LIMIT 50`,
      )
      .all<{
        id: string;
        status: string;
        reason: string;
        attemptCount: number;
        hardDeadlineAt: string;
      }>(),
    database
      .prepare(
        `SELECT
           ae.id, ae.action,
           ae.aggregate_type AS aggregateType,
           ae.aggregate_id AS aggregateId,
           ae.actor_membership_id AS actorMembershipId,
           ae.occurred_at AS occurredAt
         FROM audit_events ae
         LEFT JOIN memberships actor ON actor.id = ae.actor_membership_id
         LEFT JOIN organizations actor_org ON actor_org.id = actor.organization_id
         WHERE actor_org.kind = 'internal'
            OR ae.action LIKE 'provider_branding.%'
         ORDER BY ae.occurred_at DESC
         LIMIT 100`,
      )
      .all<{
        id: string;
        action: string;
        aggregateType: string;
        aggregateId: string;
        actorMembershipId: string | null;
        occurredAt: string;
      }>(),
    ]);
  return {
    activeRuns: Number(runs?.activeRuns ?? 0),
    attentionRuns: Number(runs?.attentionRuns ?? 0),
    deletionQueue: Number(deletions?.deletionQueue ?? 0),
    unverifiedProviders: providers.results.filter(
      (provider) =>
        !provider.verifiedDomain || !provider.brandingApprovedAt,
    ).length,
    providers: providers.results,
    recentRuns: recentRuns.results.map((run) => ({
      ...run,
      costMicroUsd: Number(run.costMicroUsd ?? 0),
    })),
    deletionJobs: deletionJobs.results.map((job) => ({
      ...job,
      attemptCount: Number(job.attemptCount ?? 0),
    })),
    recentAuditEvents: recentAuditEvents.results,
  };
}

export async function approveProviderBranding(input: {
  tenant: TenantContext;
  providerOrganizationId: string;
}): Promise<void> {
  await ensureDatabaseSchema();
  assertInternalOperator(input.tenant);
  const now = new Date().toISOString();
  const result = await getD1()
    .prepare(
      `UPDATE organizations
       SET provider_branding_approved_at = ?, updated_at = ?
       WHERE id = ? AND kind = 'provider'
         AND verified_domain IS NOT NULL
         AND provider_branding_approved_at IS NULL`,
    )
    .bind(now, now, input.providerOrganizationId)
    .run();
  if (result.meta.changes !== 1) {
    const provider = await getD1()
      .prepare(
        `SELECT verified_domain AS verifiedDomain,
                provider_branding_approved_at AS approvedAt
         FROM organizations WHERE id = ? AND kind = 'provider'`,
      )
      .bind(input.providerOrganizationId)
      .first<{ verifiedDomain: string | null; approvedAt: string | null }>();
    if (!provider) {
      throw new DomainError("NOT_FOUND", "Provider organization not found.");
    }
    if (!provider.verifiedDomain) {
      throw new DomainError(
        "INVALID_STATE_TRANSITION",
        "Domain ownership must be verified before branding approval.",
      );
    }
    if (provider.approvedAt) return;
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The provider record changed while branding was approved.",
    );
  }
  await appendAuditEvent({
    organizationId: input.providerOrganizationId,
    aggregateType: "organization",
    aggregateId: input.providerOrganizationId,
    action: "provider_branding.approved",
    actorMembershipId: input.tenant.membershipId,
    payload: {
      internalOrganizationId: input.tenant.organizationId,
      approvedAt: now,
    },
  });
}
