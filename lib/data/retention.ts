import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import { R2ArtifactStore } from "@/lib/platform/artifacts";
import { appendAuditEvent } from "./control-plane";

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
        state
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
    }>();

  const timestamp = now.toISOString();
  const hardDeadlineAt = timestamp;
  for (const run of stale.results) {
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
           SET last_failure_category = 'infrastructure', updated_at = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .bind(timestamp, run.repositoryMigrationId, run.organizationId),
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
        id,
        organization_id AS organizationId,
        artifact_id AS artifactId,
        storage_key AS storageKey,
        reason,
        attempt_count AS attemptCount
       FROM deletion_jobs
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY hard_deadline_at ASC
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
    }>();

  let deleted = 0;
  let retried = 0;
  let deadLettered = 0;
  const timestamp = now.toISOString();

  for (const job of jobs.results) {
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
        deadLettered += 1;
      } else {
        await database
          .prepare(
            `UPDATE deletion_jobs
             SET attempt_count = ?, last_error_code = ?, next_attempt_at = ?,
                 updated_at = ?
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
  return { interruptedRuns, expiredArtifacts, ...queue };
}

export type CustomerDeletionRequest = {
  queuedArtifacts: number;
};

/**
 * Customer-initiated erasure: every source-derived artifact for a repository
 * migration is queued immediately, ahead of its normal retention window.
 */
export async function requestCustomerErasure(input: {
  organizationId: string;
  repositoryMigrationId: string;
  actorMembershipId: string;
}): Promise<CustomerDeletionRequest> {
  await ensureDatabaseSchema();
  const runs = await getD1()
    .prepare(
      `SELECT id
       FROM migration_runs
       WHERE organization_id = ? AND repository_migration_id = ?`,
    )
    .bind(input.organizationId, input.repositoryMigrationId)
    .all<{ id: string }>();

  const now = new Date();
  let queuedArtifacts = 0;
  for (const run of runs.results) {
    queuedArtifacts += await enqueueRunArtifactDeletion({
      organizationId: input.organizationId,
      runId: run.id,
      reason: "customer_request",
      hardDeadlineAt: now.toISOString(),
      now,
    });
  }
  await appendAuditEvent({
    organizationId: input.organizationId,
    aggregateType: "repository_migration",
    aggregateId: input.repositoryMigrationId,
    action: "retention.customer_erasure_requested",
    actorMembershipId: input.actorMembershipId,
    payload: { queuedArtifacts, runCount: runs.results.length },
  });
  return { queuedArtifacts };
}
