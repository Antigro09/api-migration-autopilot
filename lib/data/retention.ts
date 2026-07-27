import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import type { TenantContext } from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import { R2ArtifactStore } from "@/lib/platform/artifacts";
import { emitTelemetry } from "@/lib/telemetry";
import { recordOperationalAlert } from "./alerts";
import { appendAuditEvent } from "./control-plane";
import { deleteExpiredRateLimits } from "@/lib/security/rate-limit";

export type DeletionReason =
  | "run_completed"
  | "retention_expired"
  | "customer_request";

export type RetentionSweepReport = {
  interruptedRuns: number;
  expiredArtifacts: number;
  deleted: number;
  retried: number;
  deadLettered: number;
  expiredRateLimitBuckets: number;
};

/** Run states that must not linger; anything older than the TTL is swept. */
const INTERRUPTED_RUN_STATES = [
  "queued",
  "acquiring_source",
  "analyzing",
  "awaiting_model_consent",
  "generating",
  "preparing_dependencies",
  "validating",
  "publishing",
] as const;

const INTERRUPTED_RUN_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_DELETION_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function backoffMs(attemptCount: number): number {
  return Math.min(2 ** attemptCount * 60_000, MAX_BACKOFF_MS);
}

export async function enqueueArtifactDeletion(input: {
  organizationId: string;
  artifactId: string;
  storageKey: string;
  reason: DeletionReason;
  hardDeadlineAt: string;
  now?: Date;
}): Promise<void> {
  await ensureDatabaseSchema();
  const now = (input.now ?? new Date()).toISOString();
  const database = getD1();
  await database.batch([
    database
      .prepare(
        `INSERT INTO deletion_jobs (
          id, organization_id, artifact_id, status, reason,
          hard_deadline_at, next_attempt_at, storage_key
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
        ON CONFLICT(artifact_id) DO UPDATE SET
          status = CASE WHEN deletion_jobs.status = 'completed'
                        THEN 'completed' ELSE 'pending' END,
          reason = excluded.reason,
          hard_deadline_at = MIN(deletion_jobs.hard_deadline_at, excluded.hard_deadline_at),
          next_attempt_at = excluded.next_attempt_at,
          storage_key = excluded.storage_key,
          updated_at = excluded.next_attempt_at`,
      )
      .bind(
        id("del"),
        input.organizationId,
        input.artifactId,
        input.reason,
        input.hardDeadlineAt,
        now,
        input.storageKey,
      ),
    database
      .prepare(
        `UPDATE artifacts
         SET lifecycle_state = 'deletion_queued'
         WHERE id = ? AND organization_id = ? AND lifecycle_state = 'active'`,
      )
      .bind(input.artifactId, input.organizationId),
  ]);
}

/** Queues every still-present artifact of a run for deletion. */
export async function enqueueRunArtifactDeletion(input: {
  organizationId: string;
  runId: string;
  reason: DeletionReason;
  hardDeadlineAt: string;
  kinds?: readonly string[];
  now?: Date;
}): Promise<number> {
  await ensureDatabaseSchema();
  const kinds = input.kinds ?? [
    "repository_archive",
    "affected_snippets",
    "patch",
    "patch_file",
    "validation_log",
  ];
  const placeholders = kinds.map(() => "?").join(", ");
  const artifacts = await getD1()
    .prepare(
      `SELECT id, storage_key AS storageKey
       FROM artifacts
       WHERE organization_id = ? AND run_id = ?
         AND lifecycle_state = 'active'
         AND kind IN (${placeholders})`,
    )
    .bind(input.organizationId, input.runId, ...kinds)
    .all<{ id: string; storageKey: string }>();

  for (const artifact of artifacts.results) {
    await enqueueArtifactDeletion({
      organizationId: input.organizationId,
      artifactId: artifact.id,
      storageKey: artifact.storageKey,
      reason: input.reason,
      hardDeadlineAt: input.hardDeadlineAt,
      ...(input.now ? { now: input.now } : {}),
    });
  }
  return artifacts.results.length;
}

async function sweepInterruptedRuns(now: Date): Promise<number> {
  const database = getD1();
  const cutoff = new Date(now.getTime() - INTERRUPTED_RUN_TTL_MS).toISOString();
  const placeholders = INTERRUPTED_RUN_STATES.map(() => "?").join(", ");
  const stale = await database
    .prepare(
      `SELECT
        id,
        organization_id AS organizationId,
        repository_migration_id AS repositoryMigrationId,
        state,
        kind
       FROM migration_runs
       WHERE state IN (${placeholders}) AND updated_at < ?
       ORDER BY updated_at ASC
       LIMIT 100`,
    )
    .bind(...INTERRUPTED_RUN_STATES, cutoff)
    .all<{
      id: string;
      organizationId: string;
      repositoryMigrationId: string;
      state: string;
      kind: "assessment" | "patch" | "verification";
    }>();

  const timestamp = now.toISOString();
  const hardDeadlineAt = timestamp;
  for (const run of stale.results) {
    const recoveryState =
      run.kind === "patch"
        ? "patcher_required"
        : run.kind === "verification"
          ? "merged"
          : "scanner_connected";
    await database.batch([
      database
        .prepare(
          `UPDATE migration_runs
           SET state = 'failed', failure_category = 'infrastructure',
               failure_code = 'interrupted_run_ttl', completed_at = ?,
               updated_at = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .bind(timestamp, timestamp, run.id, run.organizationId),
      database
        .prepare(
          `UPDATE repository_migrations
           SET state = ?, last_failure_category = 'infrastructure',
               updated_at = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .bind(
          recoveryState,
          timestamp,
          run.repositoryMigrationId,
          run.organizationId,
        ),
    ]);
    await enqueueRunArtifactDeletion({
      organizationId: run.organizationId,
      runId: run.id,
      reason: "run_completed",
      hardDeadlineAt,
      now,
    });
    await appendAuditEvent({
      organizationId: run.organizationId,
      aggregateType: "run",
      aggregateId: run.id,
      action: "run.interrupted_ttl_swept",
      payload: { previousState: run.state, ttlHours: 24 },
    });
    await recordOperationalAlert({
      organizationId: run.organizationId,
      runId: run.id,
      severity: "critical",
      code: "retention.interrupted_run_ttl",
      eventName: "retention.deadline_breached",
      metadata: {
        run_kind: run.kind,
        run_state: run.state,
        failure_category: "infrastructure",
        outcome: "failed",
      },
    });
  }
  return stale.results.length;
}

async function queueExpiredArtifacts(now: Date): Promise<number> {
  const expired = await getD1()
    .prepare(
      `SELECT id, organization_id AS organizationId, storage_key AS storageKey
       FROM artifacts
       WHERE lifecycle_state = 'active'
         AND expires_at IS NOT NULL
         AND expires_at <= ?
       ORDER BY expires_at ASC
       LIMIT 200`,
    )
    .bind(now.toISOString())
    .all<{ id: string; organizationId: string; storageKey: string }>();

  for (const artifact of expired.results) {
    await enqueueArtifactDeletion({
      organizationId: artifact.organizationId,
      artifactId: artifact.id,
      storageKey: artifact.storageKey,
      reason: "retention_expired",
      hardDeadlineAt: now.toISOString(),
      now,
    });
  }
  return expired.results.length;
}

async function processDeletionQueue(
  now: Date,
  limit: number,
): Promise<{ deleted: number; retried: number; deadLettered: number }> {
  const database = getD1();
  const store = new R2ArtifactStore();
  const jobs = await database
    .prepare(
      `SELECT
        deletion_jobs.id,
        deletion_jobs.organization_id AS organizationId,
        deletion_jobs.artifact_id AS artifactId,
        deletion_jobs.storage_key AS storageKey,
        deletion_jobs.reason,
        deletion_jobs.attempt_count AS attemptCount,
        deletion_jobs.hard_deadline_at AS hardDeadlineAt,
        a.run_id AS runId,
        a.kind AS artifactKind
       FROM deletion_jobs
       JOIN artifacts a ON a.id = deletion_jobs.artifact_id
       WHERE deletion_jobs.status = 'pending'
         AND deletion_jobs.next_attempt_at <= ?
       ORDER BY deletion_jobs.hard_deadline_at ASC
       LIMIT ?`,
    )
    .bind(now.toISOString(), Math.min(Math.max(limit, 1), 200))
    .all<{
      id: string;
      organizationId: string;
      artifactId: string;
      storageKey: string;
      reason: string;
      attemptCount: number;
      hardDeadlineAt: string;
      runId: string | null;
      artifactKind: string;
    }>();

  let deleted = 0;
  let retried = 0;
  let deadLettered = 0;
  const timestamp = now.toISOString();

  for (const job of jobs.results) {
    if (Date.parse(job.hardDeadlineAt) <= now.getTime()) {
      await recordOperationalAlert({
        organizationId: job.organizationId,
        ...(job.runId ? { runId: job.runId } : {}),
        severity: "critical",
        code: "retention.deletion_deadline_breached",
        eventName: "retention.deadline_breached",
        metadata: {
          artifact_kind: job.artifactKind,
          deletion_reason: job.reason,
          attempt_count: Number(job.attemptCount),
          outcome: "failed",
        },
      });
    }
    const claim = await database
      .prepare(
        `UPDATE deletion_jobs
         SET status = 'running', updated_at = ?
         WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?`,
      )
      .bind(timestamp, job.id, timestamp)
      .run();
    if (claim.meta.changes === 0) continue;
    const attempt = job.attemptCount + 1;
    try {
      await store.delete(job.organizationId, job.storageKey);
      // Deletion is only recorded after storage confirms the object is gone.
      const remaining = await store.get(job.organizationId, job.storageKey);
      if (remaining) {
        throw new Error("Object storage still returns the deleted key.");
      }
      await database.batch([
        database
          .prepare(
            `UPDATE deletion_jobs
             SET status = 'completed', attempt_count = ?, completed_at = ?,
                 last_error_code = null, updated_at = ?
             WHERE id = ?`,
          )
          .bind(attempt, timestamp, timestamp, job.id),
        database
          .prepare(
            `UPDATE artifacts
             SET lifecycle_state = 'deleted', deleted_at = ?,
                 deletion_verified_at = ?
             WHERE id = ? AND organization_id = ?`,
          )
          .bind(timestamp, timestamp, job.artifactId, job.organizationId),
      ]);
      await appendAuditEvent({
        organizationId: job.organizationId,
        aggregateType: "artifact",
        aggregateId: job.artifactId,
        action: "artifact.deletion_verified",
        payload: { reason: job.reason, attempts: attempt },
      });
      await emitTelemetry({
        name: "artifact.deleted",
        organizationId: job.organizationId,
        ...(job.runId ? { runId: job.runId } : {}),
        metadata: {
          artifact_kind: job.artifactKind,
          deletion_reason: job.reason,
          attempt_count: attempt,
          outcome: "deleted",
        },
      }).catch(() => undefined);
      deleted += 1;
    } catch (error) {
      const code =
        error instanceof Error
          ? error.name.slice(0, 64) || "deletion_failed"
          : "deletion_failed";
      if (attempt >= MAX_DELETION_ATTEMPTS) {
        await database.batch([
          database
            .prepare(
              `UPDATE deletion_jobs
               SET status = 'failed', attempt_count = ?, last_error_code = ?,
                   updated_at = ?
               WHERE id = ?`,
            )
            .bind(attempt, code, timestamp, job.id),
          database
            .prepare(
              `UPDATE artifacts
               SET lifecycle_state = 'deletion_failed'
               WHERE id = ? AND organization_id = ?`,
            )
            .bind(job.artifactId, job.organizationId),
        ]);
        await appendAuditEvent({
          organizationId: job.organizationId,
          aggregateType: "artifact",
          aggregateId: job.artifactId,
          action: "artifact.deletion_dead_lettered",
          payload: { reason: job.reason, attempts: attempt, errorCode: code },
        });
        await recordOperationalAlert({
          organizationId: job.organizationId,
          ...(job.runId ? { runId: job.runId } : {}),
          severity: "critical",
          code: "retention.deletion_dead_lettered",
          eventName: "retention.deletion_failed",
          metadata: {
            artifact_kind: job.artifactKind,
            deletion_reason: job.reason,
            attempt_count: attempt,
            outcome: "failed",
          },
        });
        deadLettered += 1;
      } else {
        await database
          .prepare(
            `UPDATE deletion_jobs
             SET status = 'pending', attempt_count = ?,
                 last_error_code = ?, next_attempt_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(
            attempt,
            code,
            new Date(now.getTime() + backoffMs(attempt)).toISOString(),
            timestamp,
            job.id,
          )
          .run();
        retried += 1;
      }
    }
  }

  return { deleted, retried, deadLettered };
}

/**
 * One retention pass: sweep interrupted runs past their hard TTL, queue expired
 * artifacts, then drain the deletion queue with verification and backoff.
 */
export async function sweepRetention(options?: {
  now?: Date;
  limit?: number;
}): Promise<RetentionSweepReport> {
  await ensureDatabaseSchema();
  const now = options?.now ?? new Date();
  const interruptedRuns = await sweepInterruptedRuns(now);
  const expiredArtifacts = await queueExpiredArtifacts(now);
  const queue = await processDeletionQueue(now, options?.limit ?? 100);
  const expiredRateLimitBuckets = await deleteExpiredRateLimits(now);
  return {
    interruptedRuns,
    expiredArtifacts,
    expiredRateLimitBuckets,
    ...queue,
  };
}

export type CustomerDeletionRequest = {
  queuedArtifacts: number;
};

function assertCustomerDataActor(tenant: TenantContext): void {
  if (tenant.organizationKind !== "customer") {
    throw new DomainError(
      "FORBIDDEN",
      "Customer retention data is available only to the owning customer organization.",
    );
  }
}

/**
 * Portable, customer-owned export of persisted migration state. It includes
 * manifests and retention evidence but not credentials or source belonging to
 * any other tenant. Expired/deleted artifact bodies are intentionally absent.
 */
export async function customerMigrationExport(input: {
  tenant: TenantContext;
  repositoryMigrationId: string;
}): Promise<Record<string, unknown>> {
  await ensureDatabaseSchema();
  assertCustomerDataActor(input.tenant);
  const database = getD1();
  const migration = await database
    .prepare(
      `SELECT
         rm.id,
         rm.state,
         rm.dependency_version AS dependencyVersion,
         rm.assessment_summary AS assessmentSummary,
         rm.verified_at AS verifiedAt,
         rm.closed_at AS closedAt,
         r.owner AS repositoryOwner,
         r.name AS repositoryName,
         c.name AS campaignName,
         c.package_name AS packageName,
         c.source_range AS sourceRange,
         c.target_version AS targetVersion
       FROM repository_migrations rm
       JOIN repositories r ON r.id = rm.repository_id
       JOIN campaigns c ON c.id = rm.campaign_id
       WHERE rm.id = ? AND rm.organization_id = ?
       LIMIT 1`,
    )
    .bind(input.repositoryMigrationId, input.tenant.organizationId)
    .first<Record<string, unknown>>();
  if (!migration) {
    throw new DomainError(
      "NOT_FOUND",
      "The repository migration was not found in this organization.",
    );
  }

  const [runs, consents, artifacts, deletionJobs] = await Promise.all([
    database
      .prepare(
        `SELECT
           id, kind, state, base_sha AS baseSha,
           patch_sha256 AS patchSha256,
           approved_patch_sha256 AS approvedPatchSha256,
           approved_by_membership_id AS approvedByMembershipId,
           approved_at AS approvedAt,
           failure_category AS failureCategory,
           failure_code AS failureCode,
           manifest, manifest_sha256 AS manifestSha256,
           merge_commit_sha AS mergeCommitSha,
           verification_run_id AS verificationRunId,
           cost_micro_usd AS costMicroUsd,
           created_at AS createdAt, started_at AS startedAt,
           completed_at AS completedAt, updated_at AS updatedAt
         FROM migration_runs
         WHERE organization_id = ? AND repository_migration_id = ?
         ORDER BY created_at ASC`,
      )
      .bind(input.tenant.organizationId, input.repositoryMigrationId)
      .all<Record<string, unknown>>(),
    database
      .prepare(
        `SELECT
           id, kind, policy_version AS policyVersion,
           membership_id AS membershipId, granted_at AS grantedAt,
           revoked_at AS revokedAt
         FROM consents
         WHERE organization_id = ? AND repository_migration_id = ?
         ORDER BY granted_at ASC`,
      )
      .bind(input.tenant.organizationId, input.repositoryMigrationId)
      .all<Record<string, unknown>>(),
    database
      .prepare(
        `SELECT
           a.id, a.run_id AS runId, a.kind, a.sha256,
           a.size_bytes AS sizeBytes, a.lifecycle_state AS lifecycleState,
           a.expires_at AS expiresAt, a.deleted_at AS deletedAt,
           a.deletion_verified_at AS deletionVerifiedAt,
           a.created_at AS createdAt
         FROM artifacts a
         JOIN migration_runs mr ON mr.id = a.run_id
         WHERE a.organization_id = ? AND mr.repository_migration_id = ?
         ORDER BY a.created_at ASC`,
      )
      .bind(input.tenant.organizationId, input.repositoryMigrationId)
      .all<Record<string, unknown>>(),
    database
      .prepare(
        `SELECT
           dj.id, dj.artifact_id AS artifactId, dj.status, dj.reason,
           dj.hard_deadline_at AS hardDeadlineAt,
           dj.attempt_count AS attemptCount,
           dj.last_error_code AS lastErrorCode,
           dj.completed_at AS completedAt
         FROM deletion_jobs dj
         JOIN artifacts a ON a.id = dj.artifact_id
         JOIN migration_runs mr ON mr.id = a.run_id
         WHERE dj.organization_id = ? AND mr.repository_migration_id = ?
         ORDER BY dj.created_at ASC`,
      )
      .bind(input.tenant.organizationId, input.repositoryMigrationId)
      .all<Record<string, unknown>>(),
  ]);

  const aggregateIds = [
    input.repositoryMigrationId,
    ...runs.results.map((row) => String(row.id)),
    ...artifacts.results.map((row) => String(row.id)),
  ];
  const placeholders = aggregateIds.map(() => "?").join(", ");
  const auditEvents = await database
    .prepare(
      `SELECT
         id, aggregate_type AS aggregateType, aggregate_id AS aggregateId,
         sequence, action, actor_membership_id AS actorMembershipId,
         payload, previous_hash AS previousHash, event_hash AS eventHash,
         occurred_at AS occurredAt
       FROM audit_events
       WHERE organization_id = ? AND aggregate_id IN (${placeholders})
       ORDER BY occurred_at ASC
       LIMIT 5000`,
    )
    .bind(input.tenant.organizationId, ...aggregateIds)
    .all<Record<string, unknown>>();

  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "repository_migration",
    aggregateId: input.repositoryMigrationId,
    action: "retention.customer_exported",
    actorMembershipId: input.tenant.membershipId,
    payload: {
      runCount: runs.results.length,
      artifactCount: artifacts.results.length,
    },
  });

  return {
    schemaVersion: "customer-migration-export/1",
    generatedAt: new Date().toISOString(),
    organizationId: input.tenant.organizationId,
    migration,
    runs: runs.results,
    consents: consents.results,
    artifacts: artifacts.results,
    deletionJobs: deletionJobs.results,
    auditEvents: auditEvents.results,
  };
}

/**
 * Customer-initiated erasure: every source-derived artifact for a repository
 * migration is queued immediately, ahead of its normal retention window.
 */
export async function requestCustomerErasure(input: {
  tenant: TenantContext;
  repositoryMigrationId: string;
}): Promise<CustomerDeletionRequest> {
  await ensureDatabaseSchema();
  if (
    input.tenant.organizationKind !== "customer" ||
    !["admin", "approver"].includes(input.tenant.role)
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "Only a customer admin or approver can request early erasure.",
    );
  }
  const migration = await getD1()
    .prepare(
      `SELECT id FROM repository_migrations
       WHERE id = ? AND organization_id = ?
       LIMIT 1`,
    )
    .bind(input.repositoryMigrationId, input.tenant.organizationId)
    .first<{ id: string }>();
  if (!migration) {
    throw new DomainError(
      "NOT_FOUND",
      "The repository migration was not found in this organization.",
    );
  }
  const runs = await getD1()
    .prepare(
      `SELECT id
       FROM migration_runs
       WHERE organization_id = ? AND repository_migration_id = ?`,
    )
    .bind(input.tenant.organizationId, input.repositoryMigrationId)
    .all<{ id: string }>();

  const now = new Date();
  let queuedArtifacts = 0;
  for (const run of runs.results) {
    queuedArtifacts += await enqueueRunArtifactDeletion({
      organizationId: input.tenant.organizationId,
      runId: run.id,
      reason: "customer_request",
      hardDeadlineAt: now.toISOString(),
      now,
    });
  }
  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "repository_migration",
    aggregateId: input.repositoryMigrationId,
    action: "retention.customer_erasure_requested",
    actorMembershipId: input.tenant.membershipId,
    payload: { queuedArtifacts, runCount: runs.results.length },
  });
  return { queuedArtifacts };
}
