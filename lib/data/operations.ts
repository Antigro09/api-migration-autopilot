import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import {
  type AuditEvent,
  type JsonObject,
  type TenantContext,
  verifyAuditChain,
} from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import {
  GitHubAppGateway,
  type GitHubGateway,
} from "@/lib/integrations/github";
import { publicAppUrl } from "@/lib/platform/config";
import {
  TriggerWorkflowEngine,
  type WorkflowEngine,
} from "@/lib/workflows/engine";
import { emitTelemetry } from "@/lib/telemetry";
import { appendAuditEvent } from "./control-plane";
import {
  listOperationalAlerts,
  type OperationalAlert,
} from "./alerts";
import {
  operationsSupportAccess,
  type OperationsSupportAccess,
} from "./support";

const MAX_OPERATION_RETRIES = 3;
const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export type OperationsProviderRecord = {
  organizationId: string;
  name: string;
  verifiedDomain: string | null;
  brandingApprovedAt: string | null;
  createdAt: string;
};

export type OperationsRunRecord = {
  id: string;
  organizationId: string;
  kind: string;
  state: string;
  failureCategory: string | null;
  failureCode: string | null;
  costMicroUsd: number;
  retryCount: number;
  retryable: boolean;
  durationMs: number;
  model: string | null;
  modelInputTokens: number;
  modelOutputTokens: number;
  sandboxSeconds: number;
  sandboxImage: string | null;
  sourceArtifactsRemaining: number;
  updatedAt: string;
};

export type OperationsOverviewData = {
  activeRuns: number;
  attentionRuns: number;
  deletionQueue: number;
  unverifiedProviders: number;
  totalCostMicroUsd: number;
  totalSandboxSeconds: number;
  providers: OperationsProviderRecord[];
  recentRuns: OperationsRunRecord[];
  deletionJobs: Array<{
    id: string;
    organizationId: string;
    status: string;
    reason: string;
    attemptCount: number;
    lastErrorCode: string | null;
    nextAttemptAt: string;
    hardDeadlineAt: string;
    deadlineBreached: boolean;
  }>;
  recentAuditEvents: Array<{
    id: string;
    organizationId: string;
    action: string;
    aggregateType: string;
    aggregateId: string;
    sequence: number;
    actorMembershipId: string | null;
    occurredAt: string;
  }>;
  supportAccess: OperationsSupportAccess;
  alerts: OperationalAlert[];
};

type RetryGateway = Pick<GitHubGateway, "getBranchSha">;

type RetryDependencies = {
  github?: RetryGateway;
  workflow?: WorkflowEngine;
  now?: Date;
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

function assertIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new DomainError("VALIDATION_FAILED", `${label} is invalid.`);
  }
}

function parseJsonObject(value: unknown): JsonObject | null {
  if (!value) return null;
  try {
    const parsed =
      typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

function usageFromManifest(value: unknown): {
  model: string | null;
  modelInputTokens: number;
  modelOutputTokens: number;
  sandboxSeconds: number;
  sandboxImage: string | null;
} {
  const manifest = parseJsonObject(value);
  const versions = parseJsonObject(manifest?.versions);
  const cost = parseJsonObject(manifest?.cost);
  const number = (candidate: unknown): number =>
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate >= 0
      ? candidate
      : 0;
  return {
    model: typeof versions?.model === "string" ? versions.model : null,
    modelInputTokens: number(cost?.modelInputTokens),
    modelOutputTokens: number(cost?.modelOutputTokens),
    sandboxSeconds: number(cost?.sandboxSeconds),
    sandboxImage:
      typeof versions?.sandboxImage === "string"
        ? versions.sandboxImage
        : null,
  };
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
  ] = await Promise.all([
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
           mr.id,
           mr.organization_id AS organizationId,
           mr.kind,
           mr.state,
           mr.failure_category AS failureCategory,
           mr.failure_code AS failureCode,
           mr.cost_micro_usd AS costMicroUsd,
           mr.retry_count AS retryCount,
           mr.manifest,
           mr.created_at AS createdAt,
           mr.completed_at AS completedAt,
           mr.updated_at AS updatedAt,
           mr.approved_patch_sha256 AS approvedPatchSha256,
           EXISTS(SELECT 1 FROM patches p WHERE p.run_id = mr.id) AS hasPatch,
           (
             SELECT COUNT(*)
             FROM artifacts a
             WHERE a.run_id = mr.id
               AND a.kind IN ('repository_archive', 'affected_snippets')
               AND a.lifecycle_state != 'deleted'
           ) AS sourceArtifactsRemaining
         FROM migration_runs mr
         ORDER BY mr.updated_at DESC
         LIMIT 50`,
      )
      .all<{
        id: string;
        organizationId: string;
        kind: string;
        state: string;
        failureCategory: string | null;
        failureCode: string | null;
        costMicroUsd: number;
        retryCount: number;
        manifest: string | JsonObject | null;
        createdAt: string;
        completedAt: string | null;
        updatedAt: string;
        approvedPatchSha256: string | null;
        hasPatch: number | boolean;
        sourceArtifactsRemaining: number;
      }>(),
    database
      .prepare(
        `SELECT
           id,
           organization_id AS organizationId,
           status,
           reason,
           attempt_count AS attemptCount,
           last_error_code AS lastErrorCode,
           next_attempt_at AS nextAttemptAt,
           hard_deadline_at AS hardDeadlineAt
         FROM deletion_jobs
         WHERE status IN ('pending', 'running', 'failed')
         ORDER BY hard_deadline_at ASC
         LIMIT 50`,
      )
      .all<{
        id: string;
        organizationId: string;
        status: string;
        reason: string;
        attemptCount: number;
        lastErrorCode: string | null;
        nextAttemptAt: string;
        hardDeadlineAt: string;
      }>(),
    database
      .prepare(
        `SELECT
           ae.id,
           ae.organization_id AS organizationId,
           ae.action,
           ae.aggregate_type AS aggregateType,
           ae.aggregate_id AS aggregateId,
           ae.sequence,
           ae.actor_membership_id AS actorMembershipId,
           ae.occurred_at AS occurredAt
         FROM audit_events ae
         LEFT JOIN memberships actor ON actor.id = ae.actor_membership_id
         LEFT JOIN organizations actor_org ON actor_org.id = actor.organization_id
         WHERE actor_org.kind = 'internal'
            OR ae.action LIKE 'provider_branding.%'
            OR ae.action LIKE 'operations.%'
            OR ae.action LIKE 'support.%'
         ORDER BY ae.occurred_at DESC
         LIMIT 100`,
      )
      .all<{
        id: string;
        organizationId: string;
        action: string;
        aggregateType: string;
        aggregateId: string;
        sequence: number;
        actorMembershipId: string | null;
        occurredAt: string;
      }>(),
  ]);

  const now = Date.now();
  const [supportAccess, alerts] = await Promise.all([
    operationsSupportAccess(tenant),
    listOperationalAlerts(tenant),
  ]);
  const mappedRuns = recentRuns.results.map((run): OperationsRunRecord => {
    const usage = usageFromManifest(run.manifest);
    const start = Date.parse(run.createdAt);
    const finish = Date.parse(run.completedAt ?? run.updatedAt);
    return {
      id: run.id,
      organizationId: run.organizationId,
      kind: run.kind,
      state: run.state,
      failureCategory: run.failureCategory,
      failureCode: run.failureCode,
      costMicroUsd: Number(run.costMicroUsd ?? 0),
      retryCount: Number(run.retryCount ?? 0),
      retryable:
        run.state === "failed" &&
        run.failureCategory === "infrastructure" &&
        Number(run.retryCount ?? 0) < MAX_OPERATION_RETRIES &&
        !run.approvedPatchSha256 &&
        !Boolean(run.hasPatch),
      durationMs:
        Number.isFinite(start) && Number.isFinite(finish)
          ? Math.max(0, finish - start)
          : 0,
      ...usage,
      sourceArtifactsRemaining: Number(run.sourceArtifactsRemaining ?? 0),
      updatedAt: run.updatedAt,
    };
  });

  return {
    activeRuns: Number(runs?.activeRuns ?? 0),
    attentionRuns: Number(runs?.attentionRuns ?? 0),
    deletionQueue: Number(deletions?.deletionQueue ?? 0),
    unverifiedProviders: providers.results.filter(
      (provider) =>
        !provider.verifiedDomain || !provider.brandingApprovedAt,
    ).length,
    totalCostMicroUsd: mappedRuns.reduce(
      (total, run) => total + run.costMicroUsd,
      0,
    ),
    totalSandboxSeconds: mappedRuns.reduce(
      (total, run) => total + run.sandboxSeconds,
      0,
    ),
    providers: providers.results,
    recentRuns: mappedRuns,
    deletionJobs: deletionJobs.results.map((job) => ({
      ...job,
      attemptCount: Number(job.attemptCount ?? 0),
      deadlineBreached: Date.parse(job.hardDeadlineAt) <= now,
    })),
    recentAuditEvents: recentAuditEvents.results.map((event) => ({
      ...event,
      sequence: Number(event.sequence),
    })),
    supportAccess,
    alerts,
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

/**
 * A safe retry never rewrites the failed run. It revalidates the GitHub
 * installation and exact base commit, creates a new immutable attempt bound to
 * the same spec revision, and dispatches it with a unique idempotency key.
 */
export async function safeRetryRun(
  input: {
    tenant: TenantContext;
    runId: string;
    reason: string;
    requestUrl?: string;
  },
  dependencies: RetryDependencies = {},
): Promise<{ runId: string; workflowRunId: string; retryCount: number }> {
  await ensureDatabaseSchema();
  assertInternalOperator(input.tenant);
  assertIdentifier(input.runId, "Run ID");
  const reason = input.reason.trim();
  if (reason.length < 8 || reason.length > 500) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Retry reason must be between 8 and 500 characters.",
    );
  }

  const database = getD1();
  const source = await database
    .prepare(
      `SELECT
         mr.id,
         mr.organization_id AS organizationId,
         mr.repository_migration_id AS repositoryMigrationId,
         mr.repository_id AS repositoryId,
         mr.campaign_id AS campaignId,
         mr.migration_spec_id AS migrationSpecId,
         mr.migration_spec_revision AS migrationSpecRevision,
         mr.state,
         mr.failure_category AS failureCategory,
         mr.base_sha AS baseSha,
         mr.kind,
         mr.merge_commit_sha AS mergeCommitSha,
         mr.retry_count AS retryCount,
         mr.approved_patch_sha256 AS approvedPatchSha256,
         rm.state AS migrationState,
         rm.latest_run_id AS latestRunId,
         r.github_repository_id AS githubRepositoryId,
         r.owner,
         r.name AS repository,
         r.default_branch AS defaultBranch,
         scanner.github_installation_id AS scannerInstallationId,
         scanner.status AS scannerStatus,
         patcher.github_installation_id AS patcherInstallationId,
         patcher.status AS patcherStatus,
         EXISTS(SELECT 1 FROM patches p WHERE p.run_id = mr.id) AS hasPatch
       FROM migration_runs mr
       JOIN repository_migrations rm ON rm.id = mr.repository_migration_id
       JOIN repositories r ON r.id = mr.repository_id
       JOIN github_installations scanner ON scanner.id = r.scanner_installation_id
       LEFT JOIN github_installations patcher ON patcher.id = r.patcher_installation_id
       WHERE mr.id = ?
       LIMIT 1`,
    )
    .bind(input.runId)
    .first<{
      id: string;
      organizationId: string;
      repositoryMigrationId: string;
      repositoryId: string;
      campaignId: string;
      migrationSpecId: string;
      migrationSpecRevision: number;
      state: string;
      failureCategory: string | null;
      baseSha: string;
      kind: "assessment" | "patch" | "verification";
      mergeCommitSha: string | null;
      retryCount: number;
      approvedPatchSha256: string | null;
      migrationState: string;
      latestRunId: string | null;
      githubRepositoryId: string;
      owner: string;
      repository: string;
      defaultBranch: string;
      scannerInstallationId: string;
      scannerStatus: string;
      patcherInstallationId: string | null;
      patcherStatus: string | null;
      hasPatch: number | boolean;
    }>();
  if (!source) throw new DomainError("NOT_FOUND", "The run was not found.");
  if (
    source.state !== "failed" ||
    source.failureCategory !== "infrastructure"
  ) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "Only failed infrastructure runs can be safely retried.",
    );
  }
  if (source.latestRunId !== source.id) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "This run is no longer the migration's current attempt.",
    );
  }
  if (source.retryCount >= MAX_OPERATION_RETRIES) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "This run has reached the maximum of three safe retries.",
    );
  }
  if (source.approvedPatchSha256 || Boolean(source.hasPatch)) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "A run with persisted or approved patch output cannot be retried by operations.",
    );
  }
  if (source.scannerStatus !== "active") {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "The Scanner App installation is not active.",
    );
  }
  if (
    source.kind === "patch" &&
    (!source.patcherInstallationId || source.patcherStatus !== "active")
  ) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "The Patcher App installation is not active.",
    );
  }

  const github = dependencies.github ?? new GitHubAppGateway();
  const currentSha = await github.getBranchSha({
    appKind: "scanner",
    installationId: Number(source.scannerInstallationId),
    repositoryId: Number(source.githubRepositoryId),
    owner: source.owner,
    repository: source.repository,
    branch: source.defaultBranch,
  });
  if (currentSha.toLowerCase() !== source.baseSha.toLowerCase()) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "The repository default branch changed. Start a fresh customer run instead.",
      {
        failureCategory: "stale_base",
        expectedBaseSha: source.baseSha,
        actualBaseSha: currentSha,
      },
    );
  }

  const retryCount = Number(source.retryCount) + 1;
  const retryRunId = `run_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = (dependencies.now ?? new Date()).toISOString();
  const targetMigrationState =
    source.kind === "patch" ? "patch_requested" : "assessing";
  try {
    const batch = await database.batch([
      database
        .prepare(
          `INSERT INTO migration_runs (
            id, organization_id, repository_migration_id, repository_id,
            campaign_id, migration_spec_id, migration_spec_revision,
            state, base_sha, kind, merge_commit_sha, retry_count,
            retry_of_run_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          retryRunId,
          source.organizationId,
          source.repositoryMigrationId,
          source.repositoryId,
          source.campaignId,
          source.migrationSpecId,
          source.migrationSpecRevision,
          source.baseSha,
          source.kind,
          source.mergeCommitSha,
          retryCount,
          source.id,
          now,
          now,
        ),
      database
        .prepare(
          `UPDATE repository_migrations
           SET state = ?, latest_run_id = ?, last_failure_category = null,
               updated_at = ?
           WHERE id = ? AND organization_id = ? AND latest_run_id = ?`,
        )
        .bind(
          targetMigrationState,
          retryRunId,
          now,
          source.repositoryMigrationId,
          source.organizationId,
          source.id,
        ),
    ]);
    if (Number(batch[1]?.meta.changes ?? 0) !== 1) {
      await database
        .prepare(
          "DELETE FROM migration_runs WHERE id = ? AND organization_id = ? AND state = 'queued'",
        )
        .bind(retryRunId, source.organizationId)
        .run();
      throw new Error("migration_claim_failed");
    }
  } catch (error) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The run was already retried or the migration changed.",
      { cause: error instanceof Error ? error.name : "unknown" },
    );
  }

  await appendAuditEvent({
    organizationId: source.organizationId,
    aggregateType: "run",
    aggregateId: retryRunId,
    action: "operations.retry_requested",
    actorMembershipId: input.tenant.membershipId,
    payload: {
      sourceRunId: source.id,
      retryCount,
      reason,
      internalOrganizationId: input.tenant.organizationId,
    },
  });

  const workflow = dependencies.workflow ?? new TriggerWorkflowEngine();
  try {
    const dispatched = await workflow.trigger({
      task: source.kind === "patch" ? "patch-run" : "assessment-run",
      payload: {
        runId: retryRunId,
        controlPlaneUrl: publicAppUrl(input.requestUrl),
      },
      idempotencyKey: `operations-retry:${source.id}:${retryCount}`,
      concurrencyKey: `repository:${source.repositoryId}`,
    });
    await database
      .prepare(
        `UPDATE migration_runs
         SET trigger_run_id = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND state = 'queued'`,
      )
      .bind(
        dispatched.id,
        new Date().toISOString(),
        retryRunId,
        source.organizationId,
      )
      .run();
    await emitTelemetry({
      name: "workflow.retry_requested",
      organizationId: source.organizationId,
      runId: retryRunId,
      metadata: {
        run_kind: source.kind,
        retry_count: retryCount,
        outcome: "retried",
      },
    }).catch(() => undefined);
    return {
      runId: retryRunId,
      workflowRunId: dispatched.id,
      retryCount,
    };
  } catch (error) {
    const failedAt = new Date().toISOString();
    await database.batch([
      database
        .prepare(
          `UPDATE migration_runs
           SET state = 'failed', failure_category = 'infrastructure',
               failure_code = 'operations_retry_dispatch_failed',
               completed_at = ?, updated_at = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .bind(failedAt, failedAt, retryRunId, source.organizationId),
      database
        .prepare(
          `UPDATE repository_migrations
           SET state = ?, latest_run_id = ?,
               last_failure_category = 'infrastructure', updated_at = ?
           WHERE id = ? AND organization_id = ? AND latest_run_id = ?`,
        )
        .bind(
          source.migrationState,
          source.id,
          failedAt,
          source.repositoryMigrationId,
          source.organizationId,
          retryRunId,
        ),
    ]);
    await appendAuditEvent({
      organizationId: source.organizationId,
      aggregateType: "run",
      aggregateId: retryRunId,
      action: "operations.retry_dispatch_failed",
      actorMembershipId: input.tenant.membershipId,
      payload: {
        sourceRunId: source.id,
        retryCount,
        errorClass: error instanceof Error ? error.name : "unknown",
      },
    });
    throw error;
  }
}

export async function retryDeletionJob(input: {
  tenant: TenantContext;
  deletionJobId: string;
  reason: string;
}): Promise<void> {
  await ensureDatabaseSchema();
  assertInternalOperator(input.tenant);
  assertIdentifier(input.deletionJobId, "Deletion job ID");
  const reason = input.reason.trim();
  if (reason.length < 8 || reason.length > 500) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Retry reason must be between 8 and 500 characters.",
    );
  }
  const database = getD1();
  const job = await database
    .prepare(
      `SELECT organization_id AS organizationId, status, attempt_count AS attemptCount
       FROM deletion_jobs WHERE id = ? LIMIT 1`,
    )
    .bind(input.deletionJobId)
    .first<{
      organizationId: string;
      status: string;
      attemptCount: number;
    }>();
  if (!job) throw new DomainError("NOT_FOUND", "Deletion job not found.");
  if (job.status !== "failed") {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "Only a failed deletion job can be retried.",
    );
  }
  if (Number(job.attemptCount) >= 10) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "This deletion job requires incident escalation after ten attempts.",
    );
  }
  const now = new Date().toISOString();
  const changed = await database
    .prepare(
      `UPDATE deletion_jobs
       SET status = 'pending', next_attempt_at = ?, last_error_code = null,
           updated_at = ?
       WHERE id = ? AND status = 'failed'`,
    )
    .bind(now, now, input.deletionJobId)
    .run();
  if (changed.meta.changes !== 1) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The deletion job changed before it could be retried.",
    );
  }
  await appendAuditEvent({
    organizationId: job.organizationId,
    aggregateType: "deletion_job",
    aggregateId: input.deletionJobId,
    action: "operations.deletion_retry_requested",
    actorMembershipId: input.tenant.membershipId,
    payload: {
      reason,
      priorAttemptCount: Number(job.attemptCount),
      internalOrganizationId: input.tenant.organizationId,
    },
  });
}

export async function verifyAuditAggregate(input: {
  tenant: TenantContext;
  organizationId: string;
  aggregateType: string;
  aggregateId: string;
}): Promise<{ eventCount: number; rootHash: string | null }> {
  await ensureDatabaseSchema();
  assertInternalOperator(input.tenant);
  assertIdentifier(input.organizationId, "Organization ID");
  assertIdentifier(input.aggregateType, "Aggregate type");
  assertIdentifier(input.aggregateId, "Aggregate ID");
  const rows = await getD1()
    .prepare(
      `SELECT
         id,
         organization_id AS organizationId,
         aggregate_type AS aggregateType,
         aggregate_id AS aggregateId,
         sequence,
         action,
         actor_membership_id AS actorMembershipId,
         occurred_at AS occurredAt,
         payload,
         previous_hash AS previousHash,
         event_hash AS eventHash
       FROM audit_events
       WHERE organization_id = ? AND aggregate_type = ? AND aggregate_id = ?
       ORDER BY sequence ASC`,
    )
    .bind(input.organizationId, input.aggregateType, input.aggregateId)
    .all<{
      id: string;
      organizationId: string;
      aggregateType: string;
      aggregateId: string;
      sequence: number;
      action: string;
      actorMembershipId: string | null;
      occurredAt: string;
      payload: string | JsonObject;
      previousHash: string | null;
      eventHash: string;
    }>();
  if (rows.results.length === 0) {
    throw new DomainError("NOT_FOUND", "No audit chain was found.");
  }
  const events: AuditEvent[] = rows.results.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    sequence: Number(row.sequence),
    action: row.action,
    ...(row.actorMembershipId
      ? { actorMembershipId: row.actorMembershipId }
      : {}),
    occurredAt: row.occurredAt,
    payload: parseJsonObject(row.payload) ?? {},
    previousHash: row.previousHash,
    eventHash: row.eventHash,
  }));
  const result = await verifyAuditChain(events);
  return { eventCount: result.eventCount, rootHash: result.rootHash };
}
