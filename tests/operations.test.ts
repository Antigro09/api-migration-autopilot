import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { resetControlPlane } from "./support/runtime";

const { getD1 } = await import("@/db");
const {
  retryDeletionJob,
  safeRetryRun,
  verifyAuditAggregate,
} = await import("@/lib/data/operations");
const { seedPatchRun, seedTenant } = await import("./support/factory");

beforeEach(() => {
  resetControlPlane();
});

async function internalOperator() {
  const organizationId = "org_internal_ops";
  const membershipId = "mem_internal_ops";
  await getD1().batch([
    getD1()
      .prepare(
        "INSERT INTO organizations (id, workos_organization_id, name, kind) VALUES (?, ?, 'Autopilot Operations', 'internal')",
      )
      .bind(organizationId, "siwc:internal-ops"),
    getD1()
      .prepare(
        "INSERT INTO memberships (id, organization_id, workos_user_id, role, status) VALUES (?, ?, 'siwc:internal-operator', 'operator', 'active')",
      )
      .bind(membershipId, organizationId),
  ]);
  return {
    organizationId,
    membershipId,
    userId: "internal-operator",
    role: "operator",
    organizationKind: "internal",
  } as const;
}

test("operations safe retry creates a new immutable run after rechecking the exact base", async () => {
  const tenant = await seedTenant({ migrationState: "patcher_required" });
  const failedRunId = await seedPatchRun(tenant, {
    state: "failed",
    migrationState: "patcher_required",
  });
  await getD1()
    .prepare(
      `UPDATE migration_runs
       SET failure_category = 'infrastructure',
           failure_code = 'sandbox_outage',
           completed_at = ?
       WHERE id = ?`,
    )
    .bind(new Date().toISOString(), failedRunId)
    .run();
  const operator = await internalOperator();
  const dispatches: Array<Record<string, unknown>> = [];

  const result = await safeRetryRun(
    {
      tenant: operator,
      runId: failedRunId,
      reason: "E2B reported a confirmed regional outage.",
      requestUrl: "https://autopilot.test",
    },
    {
      github: {
        getBranchSha: async () => tenant.baseSha,
      },
      workflow: {
        trigger: async (command) => {
          dispatches.push(command);
          return { id: "trigger_retry_1", task: command.task };
        },
      },
    },
  );

  assert.notEqual(result.runId, failedRunId);
  assert.equal(result.retryCount, 1);
  assert.equal(dispatches[0]?.task, "patch-run");
  assert.equal(
    dispatches[0]?.idempotencyKey,
    `operations-retry:${failedRunId}:1`,
  );
  const source = await getD1()
    .prepare(
      "SELECT state, failure_code AS failureCode FROM migration_runs WHERE id = ?",
    )
    .bind(failedRunId)
    .first<{ state: string; failureCode: string }>();
  assert.equal(source?.state, "failed");
  assert.equal(source?.failureCode, "sandbox_outage");
  const retried = await getD1()
    .prepare(
      `SELECT state, retry_count AS retryCount, retry_of_run_id AS retryOfRunId,
              trigger_run_id AS triggerRunId
       FROM migration_runs WHERE id = ?`,
    )
    .bind(result.runId)
    .first<{
      state: string;
      retryCount: number;
      retryOfRunId: string;
      triggerRunId: string;
    }>();
  assert.equal(retried?.state, "queued");
  assert.equal(retried?.retryCount, 1);
  assert.equal(retried?.retryOfRunId, failedRunId);
  assert.equal(retried?.triggerRunId, "trigger_retry_1");
  const migration = await getD1()
    .prepare(
      "SELECT state, latest_run_id AS latestRunId FROM repository_migrations WHERE id = ?",
    )
    .bind(tenant.repositoryMigrationId)
    .first<{ state: string; latestRunId: string }>();
  assert.equal(migration?.state, "patch_requested");
  assert.equal(migration?.latestRunId, result.runId);

  const verified = await verifyAuditAggregate({
    tenant: operator,
    organizationId: tenant.customerOrganizationId,
    aggregateType: "run",
    aggregateId: result.runId,
  });
  assert.equal(verified.eventCount, 1);
  assert.match(verified.rootHash ?? "", /^[a-f0-9]{64}$/);
});

test("operations safe retry refuses a stale base before creating a run", async () => {
  const tenant = await seedTenant({ migrationState: "patcher_required" });
  const failedRunId = await seedPatchRun(tenant, {
    state: "failed",
    migrationState: "patcher_required",
  });
  await getD1()
    .prepare(
      "UPDATE migration_runs SET failure_category = 'infrastructure' WHERE id = ?",
    )
    .bind(failedRunId)
    .run();
  const operator = await internalOperator();
  await assert.rejects(
    safeRetryRun(
      {
        tenant: operator,
        runId: failedRunId,
        reason: "The sandbox outage has been resolved.",
      },
      {
        github: { getBranchSha: async () => "b".repeat(40) },
        workflow: {
          trigger: async (command) => ({
            id: "must_not_dispatch",
            task: command.task,
          }),
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("default branch changed"),
  );
  const retries = await getD1()
    .prepare(
      "SELECT COUNT(*) AS count FROM migration_runs WHERE retry_of_run_id = ?",
    )
    .bind(failedRunId)
    .first<{ count: number }>();
  assert.equal(retries?.count, 0);
});

test("failed deletion jobs can be deliberately requeued and are audited", async () => {
  const tenant = await seedTenant();
  const operator = await internalOperator();
  const artifactId = "art_failed_delete";
  const deletionJobId = "del_failed_delete";
  const now = new Date().toISOString();
  await getD1().batch([
    getD1()
      .prepare(
        `INSERT INTO artifacts (
          id, organization_id, run_id, kind, storage_key, sha256,
          size_bytes, encryption_key_id, lifecycle_state, expires_at
        ) VALUES (?, ?, ?, 'patch', ?, ?, 10, 'test-key',
                  'deletion_failed', ?)`,
      )
      .bind(
        artifactId,
        tenant.customerOrganizationId,
        tenant.assessmentRunId,
        "test/failed-delete",
        "0".repeat(64),
        now,
      ),
    getD1()
      .prepare(
        `INSERT INTO deletion_jobs (
          id, organization_id, artifact_id, status, reason,
          hard_deadline_at, next_attempt_at, storage_key,
          attempt_count, last_error_code
        ) VALUES (?, ?, ?, 'failed', 'retention_expired',
                  ?, ?, 'test/failed-delete', 3, 'storage_unavailable')`,
      )
      .bind(
        deletionJobId,
        tenant.customerOrganizationId,
        artifactId,
        now,
        now,
      ),
  ]);

  await retryDeletionJob({
    tenant: operator,
    deletionJobId,
    reason: "Object storage is healthy after the incident.",
  });
  const job = await getD1()
    .prepare(
      "SELECT status, attempt_count AS attemptCount, last_error_code AS lastErrorCode FROM deletion_jobs WHERE id = ?",
    )
    .bind(deletionJobId)
    .first<{
      status: string;
      attemptCount: number;
      lastErrorCode: string | null;
    }>();
  assert.equal(job?.status, "pending");
  assert.equal(job?.attemptCount, 3);
  assert.equal(job?.lastErrorCode, null);
  const verified = await verifyAuditAggregate({
    tenant: operator,
    organizationId: tenant.customerOrganizationId,
    aggregateType: "deletion_job",
    aggregateId: deletionJobId,
  });
  assert.equal(verified.eventCount, 1);
});
