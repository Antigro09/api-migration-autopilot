import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import {
  parseMigrationSpecV1,
  type MigrationSpecV1,
  type TenantContext,
} from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import { GitHubAppGateway } from "@/lib/integrations/github";
import type { MigrationAssessment } from "@/lib/migration/contracts";
import { normalizeRepositoryPath } from "@/lib/migration/patch-security";
import { publicAppUrl } from "@/lib/platform/config";
import { TriggerWorkflowEngine } from "@/lib/workflows/engine";
import { storeRunArtifact } from "./artifacts";
import { appendAuditEvent } from "./control-plane";

export type AssessmentWorkPacket = {
  runId: string;
  organizationId: string;
  repositoryMigrationId: string;
  githubInstallationId: number;
  githubRepositoryId: number;
  owner: string;
  repository: string;
  baseSha: string;
  campaignId: string;
  specId: string;
  specRevision: number;
  packageName: string;
  spec: MigrationSpecV1;
  alreadyCompleted: boolean;
};

export type AssessmentExecutionEvidence = {
  analyzerVersion: string;
  sandboxId: string;
  sandboxImageVersion: string;
  network: "none";
  sandboxDestroyedAt: string;
  sourceDeletedAt: string;
  model?: {
    model: string;
    responseId: string;
    inputTokens: number;
    outputTokens: number;
  };
};

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function requestAssessment(input: {
  tenant: TenantContext;
  invitationId: string;
  repositoryId: string;
  requestUrl: string;
}): Promise<{ runId: string; workflowRunId: string }> {
  await ensureDatabaseSchema();
  if (
    input.tenant.organizationKind !== "customer" ||
    !["admin", "operator", "approver"].includes(input.tenant.role)
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "Your organization role cannot request repository assessments.",
    );
  }
  const database = getD1();
  const context = await database
    .prepare(
      `SELECT
        ci.campaign_id AS campaignId,
        cp.id AS participantId,
        c.current_spec_id AS specId,
        c.status AS campaignStatus,
        ms.revision AS specRevision,
        ms.status AS specStatus,
        c.package_name AS packageName,
        r.id AS repositoryId,
        r.github_repository_id AS githubRepositoryId,
        r.owner,
        r.name AS repository,
        r.default_branch AS defaultBranch,
        gi.github_installation_id AS githubInstallationId,
        gi.status AS scannerStatus
       FROM customer_invitations ci
       JOIN campaign_participants cp ON cp.invitation_id = ci.id
       JOIN campaigns c ON c.id = ci.campaign_id
       JOIN migration_specs ms ON ms.id = c.current_spec_id
       JOIN repositories r ON r.id = ?
       JOIN github_installations gi ON gi.id = r.scanner_installation_id
       WHERE ci.id = ?
         AND ci.customer_organization_id = ?
         AND ci.status = 'accepted'
         AND cp.customer_organization_id = ?
         AND r.organization_id = ?
       LIMIT 1`,
    )
    .bind(
      input.repositoryId,
      input.invitationId,
      input.tenant.organizationId,
      input.tenant.organizationId,
      input.tenant.organizationId,
    )
    .first<{
      campaignId: string;
      participantId: string;
      specId: string;
      campaignStatus: string;
      specRevision: number;
      specStatus: string;
      packageName: string;
      repositoryId: string;
      githubRepositoryId: string;
      owner: string;
      repository: string;
      defaultBranch: string;
      githubInstallationId: string;
      scannerStatus: string;
    }>();
  if (!context) {
    throw new DomainError(
      "NOT_FOUND",
      "Accepted invitation or selected repository not found.",
    );
  }
  if (
    context.campaignStatus !== "live" ||
    context.specStatus !== "approved" ||
    context.scannerStatus !== "active"
  ) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "The campaign, specification, and Scanner App must be active.",
    );
  }
  const gateway = new GitHubAppGateway();
  const baseSha = await gateway.getBranchSha({
    appKind: "scanner",
    installationId: Number(context.githubInstallationId),
    repositoryId: Number(context.githubRepositoryId),
    owner: context.owner,
    repository: context.repository,
    branch: context.defaultBranch,
  });

  const existingMigration = await database
    .prepare(
      `SELECT id, state
       FROM repository_migrations
       WHERE organization_id = ? AND repository_id = ? AND campaign_id = ?
       LIMIT 1`,
    )
    .bind(
      input.tenant.organizationId,
      context.repositoryId,
      context.campaignId,
    )
    .first<{ id: string; state: string }>();
  if (
    existingMigration &&
    ["assessing", "patch_requested", "generating", "validating"].includes(
      existingMigration.state,
    )
  ) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "A migration workflow is already active for this repository.",
    );
  }

  const repositoryMigrationId = existingMigration?.id ?? id("rmg");
  const runId = id("run");
  const now = new Date().toISOString();
  const commands = [];
  if (!existingMigration) {
    commands.push(
      database
        .prepare(
          `INSERT INTO repository_migrations (
            id, organization_id, repository_id, campaign_id,
            campaign_participant_id, migration_spec_id, state, latest_run_id
          ) VALUES (?, ?, ?, ?, ?, ?, 'assessing', ?)`,
        )
        .bind(
          repositoryMigrationId,
          input.tenant.organizationId,
          context.repositoryId,
          context.campaignId,
          context.participantId,
          context.specId,
          runId,
        ),
    );
  } else {
    commands.push(
      database
        .prepare(
          `UPDATE repository_migrations
           SET state = 'assessing', migration_spec_id = ?, latest_run_id = ?,
               last_failure_category = null, updated_at = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .bind(
          context.specId,
          runId,
          now,
          repositoryMigrationId,
          input.tenant.organizationId,
        ),
    );
  }
  commands.push(
    database
      .prepare(
        `INSERT INTO migration_runs (
          id, organization_id, repository_migration_id, repository_id,
          campaign_id, migration_spec_id, migration_spec_revision,
          state, base_sha
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .bind(
        runId,
        input.tenant.organizationId,
        repositoryMigrationId,
        context.repositoryId,
        context.campaignId,
        context.specId,
        context.specRevision,
        baseSha,
      ),
    database
      .prepare(
        `UPDATE repositories
         SET last_known_sha = ?, updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(
        baseSha,
        now,
        context.repositoryId,
        input.tenant.organizationId,
      ),
  );
  await database.batch(commands);

  try {
    const workflow = await new TriggerWorkflowEngine().trigger({
      task: "assessment-run",
      payload: {
        runId,
        controlPlaneUrl: publicAppUrl(input.requestUrl),
      },
      idempotencyKey: `assessment:${runId}`,
      concurrencyKey: `repository:${context.repositoryId}`,
    });
    await database
      .prepare(
        "UPDATE migration_runs SET trigger_run_id = ?, updated_at = ? WHERE id = ? AND organization_id = ?",
      )
      .bind(
        workflow.id,
        new Date().toISOString(),
        runId,
        input.tenant.organizationId,
      )
      .run();
    await appendAuditEvent({
      organizationId: input.tenant.organizationId,
      aggregateType: "run",
      aggregateId: runId,
      action: "assessment.requested",
      actorMembershipId: input.tenant.membershipId,
      payload: {
        campaignId: context.campaignId,
        specId: context.specId,
        specRevision: context.specRevision,
        baseSha,
      },
    });
    return { runId, workflowRunId: workflow.id };
  } catch (error) {
    await database.batch([
      database
        .prepare(
          `UPDATE migration_runs
           SET state = 'failed', failure_category = 'infrastructure',
               failure_code = 'workflow_dispatch_failed', completed_at = ?,
               updated_at = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .bind(now, now, runId, input.tenant.organizationId),
      database
        .prepare(
          `UPDATE repository_migrations
           SET state = 'scanner_connected',
               last_failure_category = 'infrastructure', updated_at = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .bind(now, repositoryMigrationId, input.tenant.organizationId),
    ]);
    throw error;
  }
}

export async function assessmentWorkPacket(
  runId: string,
): Promise<AssessmentWorkPacket | null> {
  await ensureDatabaseSchema();
  const packet = await getD1()
    .prepare(
      `SELECT
        mr.id AS runId,
        mr.organization_id AS organizationId,
        mr.repository_migration_id AS repositoryMigrationId,
        CAST(gi.github_installation_id AS INTEGER) AS githubInstallationId,
        CAST(r.github_repository_id AS INTEGER) AS githubRepositoryId,
        r.owner,
        r.name AS repository,
        mr.base_sha AS baseSha,
        mr.campaign_id AS campaignId,
        mr.migration_spec_id AS specId,
        mr.migration_spec_revision AS specRevision,
        c.package_name AS packageName,
        ms.content AS specContent
       FROM migration_runs mr
       JOIN repositories r ON r.id = mr.repository_id
       JOIN github_installations gi ON gi.id = r.scanner_installation_id
       JOIN campaigns c ON c.id = mr.campaign_id
       JOIN migration_specs ms ON ms.id = mr.migration_spec_id
       WHERE mr.id = ?
         AND mr.state IN ('queued', 'acquiring_source', 'analyzing', 'cleaned')
       LIMIT 1`,
    )
    .bind(runId)
    .first<Omit<AssessmentWorkPacket, "spec" | "alreadyCompleted"> & {
      specContent: string | MigrationSpecV1;
    }>();
  if (!packet) return null;
  const spec = parseMigrationSpecV1(
    typeof packet.specContent === "string"
      ? JSON.parse(packet.specContent)
      : packet.specContent,
  );
  const runState = await getD1()
    .prepare("SELECT state FROM migration_runs WHERE id = ? LIMIT 1")
    .bind(runId)
    .first<{ state: string }>();
  await getD1()
    .prepare(
      `UPDATE migration_runs
       SET state = 'analyzing', started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND state IN ('queued', 'acquiring_source', 'analyzing')`,
    )
    .bind(new Date().toISOString(), new Date().toISOString(), runId)
    .run();
  return {
    runId: packet.runId,
    organizationId: packet.organizationId,
    repositoryMigrationId: packet.repositoryMigrationId,
    githubInstallationId: packet.githubInstallationId,
    githubRepositoryId: packet.githubRepositoryId,
    owner: packet.owner,
    repository: packet.repository,
    baseSha: packet.baseSha,
    campaignId: packet.campaignId,
    specId: packet.specId,
    specRevision: packet.specRevision,
    packageName: packet.packageName,
    spec,
    alreadyCompleted: runState?.state === "cleaned",
  };
}

function confidence(value: string): number {
  if (value === "certain") return 10_000;
  if (value === "high") return 9_000;
  if (value === "medium") return 6_500;
  return 3_500;
}

export async function completeAssessment(input: {
  runId: string;
  assessment: MigrationAssessment;
  skipped: Array<{ path: string; reason: string }>;
  execution: AssessmentExecutionEvidence;
}): Promise<void> {
  await ensureDatabaseSchema();
  if (input.assessment.findings.length > 10_000) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Assessment contains too many findings.",
    );
  }
  const database = getD1();
  const run = await database
    .prepare(
      `SELECT
        mr.organization_id AS organizationId,
        mr.repository_migration_id AS repositoryMigrationId,
        mr.campaign_id AS campaignId,
        mr.migration_spec_id AS specId,
        mr.migration_spec_revision AS specRevision,
        mr.base_sha AS baseSha,
        mr.kind,
        rm.campaign_participant_id AS participantId
       FROM migration_runs mr
       JOIN repository_migrations rm ON rm.id = mr.repository_migration_id
       WHERE mr.id = ? AND mr.state = 'analyzing'
       LIMIT 1`,
    )
    .bind(input.runId)
    .first<{
      organizationId: string;
      repositoryMigrationId: string;
      campaignId: string;
      specId: string;
      specRevision: number;
      baseSha: string;
      kind: string;
      participantId: string;
    }>();
  if (!run) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "Assessment run is not in the analyzing state.",
    );
  }
  if (
    input.assessment.specId !== run.specId ||
    input.assessment.specRevision !== run.specRevision
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Assessment engine version does not match the bound specification.",
    );
  }

  const allSkipped = [...input.assessment.skipped, ...input.skipped].slice(
    0,
    2_000,
  );
  const partialForInfrastructure = allSkipped.some(
    (item) =>
      item.path === "[repository]" ||
      item.reason.includes("limit") ||
      item.reason.includes("truncated"),
  );
  const status =
    partialForInfrastructure && input.assessment.status === "no-impact"
      ? "partial-coverage"
      : input.assessment.status;
  const verification = run.kind === "verification";
  // A verification scan that finds no remaining impact is what turns a merged
  // migration into a verified one; residual impact returns it to the normal
  // impact states so a follow-up patch can be requested.
  const migrationState = verification
    ? status === "no-impact"
      ? "verified"
      : status === "impact-found"
        ? "impact_found"
        : "partial_coverage"
    : status === "no-impact"
      ? "no_impact"
      : status === "impact-found"
        ? "impact_found"
        : "partial_coverage";
  const now = new Date().toISOString();
  const assessmentManifest = {
    schemaVersion: "2",
    kind: "assessment",
    runId: input.runId,
    organizationId: run.organizationId,
    repositoryMigrationId: run.repositoryMigrationId,
    campaignId: run.campaignId,
    migrationSpecId: run.specId,
    migrationSpecRevision: run.specRevision,
    baseSha: run.baseSha,
    versions: {
      analyzer: input.execution.analyzerVersion,
      sandboxImage: input.execution.sandboxImageVersion,
      ...(input.execution.model
        ? { model: input.execution.model.model }
        : {}),
    },
    scope: {
      scannedFiles: input.assessment.scannedFiles.length,
      skippedEntries: allSkipped.length,
      findings: input.assessment.findings.length,
      status,
    },
    executionPolicy: {
      network: input.execution.network,
      secrets: [],
      repositoryCodeExecuted: false,
    },
    sandbox: {
      id: input.execution.sandboxId,
      destroyedAt: input.execution.sandboxDestroyedAt,
    },
    ...(input.execution.model ? { model: input.execution.model } : {}),
    cleanup: {
      sourceDeletedAt: input.execution.sourceDeletedAt,
      sandboxDestroyedAt: input.execution.sandboxDestroyedAt,
      complete: true,
    },
    completedAt: now,
  } as const;
  const manifestArtifact = await storeRunArtifact({
    organizationId: run.organizationId,
    runId: input.runId,
    campaignId: run.campaignId,
    kind: "run_manifest",
    storageKey: `runs/${input.runId}/assessment-manifest-v2.json.enc`,
    plaintext: JSON.stringify(assessmentManifest),
    contentType: "application/json",
  });
  const statements = input.assessment.findings.map((finding) => {
    const path = normalizeRepositoryPath(finding.path);
    return database
      .prepare(
        `INSERT INTO findings (
          id, organization_id, run_id, rule_id, classification,
          confidence_basis_points, details
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id("fnd"),
        run.organizationId,
        input.runId,
        finding.ruleId,
        finding.coverage === "unsupported"
          ? "unsupported"
          : finding.coverage === "partial"
            ? "uncertain"
            : "affected",
        confidence(finding.confidence),
        JSON.stringify({
          path,
          location: finding.location,
          message: finding.message,
          autoPatchEligible: finding.autoPatchEligible,
          evidence: finding.evidence.map((citation) => ({
            title: citation.title,
            ...(citation.url ? { url: citation.url } : {}),
          })),
        }),
      );
  });
  statements.push(
    database
      .prepare(
        `UPDATE repository_migrations
         SET state = ?, dependency_version = ?, assessment_summary = ?,
             verified_at = ?, last_failure_category = null, updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(
        migrationState,
        input.assessment.dependency.resolvedVersion ?? null,
        JSON.stringify({
          status,
          dependency: input.assessment.dependency,
          findingCount: input.assessment.findings.length,
          scannedFiles: input.assessment.scannedFiles.length,
          scannedPaths: input.assessment.scannedFiles.slice(0, 2_000),
          skipped: allSkipped,
        }),
        migrationState === "verified" ? now : null,
        now,
        run.repositoryMigrationId,
        run.organizationId,
      ),
    database
      .prepare(
        `UPDATE migration_runs
         SET state = ?, manifest = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND state = 'analyzing'`,
      )
      .bind(
        verification && migrationState === "verified" ? "verified" : "cleaned",
        JSON.stringify({
          ...assessmentManifest,
          artifact: {
            id: manifestArtifact.id,
            sha256: manifestArtifact.sha256,
          },
        }),
        now,
        now,
        input.runId,
        run.organizationId,
      ),
    database
      .prepare(
        `UPDATE campaign_participants
         SET lifecycle_status = ?, updated_at = ?
         WHERE id = ? AND share_lifecycle_with_provider = true`,
      )
      .bind(
        migrationState === "verified"
          ? "verified"
          : status === "no-impact"
            ? "assessed"
            : "affected",
        now,
        run.participantId,
      ),
  );
  await database.batch(statements);
  await appendAuditEvent({
    organizationId: run.organizationId,
    aggregateType: "run",
    aggregateId: input.runId,
    action: verification ? "verification.completed" : "assessment.completed",
    payload: {
      status,
      runKind: run.kind,
      findingCount: input.assessment.findings.length,
      scannedFileCount: input.assessment.scannedFiles.length,
      skippedCount: allSkipped.length,
      sourceRetained: false,
      analyzerVersion: input.execution.analyzerVersion,
      sandboxImageVersion: input.execution.sandboxImageVersion,
      assessmentManifestSha256: manifestArtifact.sha256,
    },
  });
}

export async function failAssessment(
  runId: string,
  failureCode: string,
): Promise<void> {
  await ensureDatabaseSchema();
  const now = new Date().toISOString();
  const database = getD1();
  const run = await database
    .prepare(
      `SELECT organization_id AS organizationId,
              repository_migration_id AS repositoryMigrationId
       FROM migration_runs
       WHERE id = ? AND state IN ('queued', 'acquiring_source', 'analyzing')
       LIMIT 1`,
    )
    .bind(runId)
    .first<{ organizationId: string; repositoryMigrationId: string }>();
  if (!run) return;
  await database.batch([
    database
      .prepare(
        `UPDATE migration_runs
         SET state = 'failed', failure_category = 'infrastructure',
             failure_code = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(
        failureCode.slice(0, 128),
        now,
        now,
        runId,
        run.organizationId,
      ),
    database
      .prepare(
        `UPDATE repository_migrations
         SET state = 'scanner_connected',
             last_failure_category = 'infrastructure', updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(now, run.repositoryMigrationId, run.organizationId),
  ]);
}

/**
 * Queues a fresh Scanner assessment at the exact merged commit. A migration is
 * only `verified` once that scan completes clean, so `merged` and `verified`
 * remain distinguishable states.
 */
export async function enqueueVerificationScan(input: {
  organizationId: string;
  repositoryMigrationId: string;
  mergedRunId: string;
  mergeCommitSha: string;
  requestUrl: string;
}): Promise<{ runId: string } | null> {
  await ensureDatabaseSchema();
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(input.mergeCommitSha)) {
    return null;
  }
  const database = getD1();
  const context = await database
    .prepare(
      `SELECT
        rm.id AS migrationId,
        rm.state AS migrationState,
        rm.campaign_id AS campaignId,
        rm.migration_spec_id AS specId,
        ms.revision AS specRevision,
        rm.repository_id AS repositoryId,
        gi.status AS scannerStatus
       FROM repository_migrations rm
       JOIN migration_specs ms ON ms.id = rm.migration_spec_id
       JOIN repositories r ON r.id = rm.repository_id
       JOIN github_installations gi ON gi.id = r.scanner_installation_id
       WHERE rm.id = ? AND rm.organization_id = ?
       LIMIT 1`,
    )
    .bind(input.repositoryMigrationId, input.organizationId)
    .first<{
      migrationId: string;
      migrationState: string;
      campaignId: string;
      specId: string;
      specRevision: number;
      repositoryId: string;
      scannerStatus: string;
    }>();
  if (!context || context.scannerStatus !== "active") return null;
  if (context.migrationState !== "merged") return null;

  const runId = id("run");
  const now = new Date().toISOString();
  // Atomically claim the merged migration before creating a verification run.
  // This closes the race between distinct-but-equivalent GitHub webhook
  // deliveries without relying only on delivery-id deduplication.
  const claim = await database
    .prepare(
      `UPDATE repository_migrations
       SET state = 'assessing', latest_run_id = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND state = 'merged'`,
    )
    .bind(runId, now, context.migrationId, input.organizationId)
    .run();
  if (claim.meta.changes === 0) return null;

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO migration_runs (
            id, organization_id, repository_migration_id, repository_id,
            campaign_id, migration_spec_id, migration_spec_revision,
            state, base_sha, kind, merge_commit_sha
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, 'verification', ?)`,
        )
        .bind(
          runId,
          input.organizationId,
          context.migrationId,
          context.repositoryId,
          context.campaignId,
          context.specId,
          context.specRevision,
          input.mergeCommitSha.toLowerCase(),
          input.mergeCommitSha.toLowerCase(),
        ),
      database
        .prepare(
          `UPDATE migration_runs SET verification_run_id = ?, updated_at = ?
           WHERE id = ? AND organization_id = ?
             AND verification_run_id IS NULL`,
        )
        .bind(runId, now, input.mergedRunId, input.organizationId),
    ]);
  } catch (error) {
    await database
      .prepare(
        `UPDATE repository_migrations
         SET state = 'merged', latest_run_id = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND state = 'assessing'
           AND latest_run_id = ?`,
      )
      .bind(
        input.mergedRunId,
        new Date().toISOString(),
        context.migrationId,
        input.organizationId,
        runId,
      )
      .run();
    throw error;
  }

  await appendAuditEvent({
    organizationId: input.organizationId,
    aggregateType: "run",
    aggregateId: runId,
    action: "verification.requested",
    payload: {
      mergedRunId: input.mergedRunId,
      mergeCommitSha: input.mergeCommitSha.toLowerCase(),
    },
  });

  try {
    const workflow = await new TriggerWorkflowEngine().trigger({
      task: "assessment-run",
      payload: { runId, controlPlaneUrl: publicAppUrl(input.requestUrl) },
      idempotencyKey: `verification:${runId}`,
      concurrencyKey: `repository:${context.repositoryId}`,
    });
    await database
      .prepare(
        "UPDATE migration_runs SET trigger_run_id = ?, updated_at = ? WHERE id = ? AND organization_id = ?",
      )
      .bind(workflow.id, new Date().toISOString(), runId, input.organizationId)
      .run();
  } catch {
    // Dispatch failure keeps the migration merged-but-unverified rather than
    // claiming verification that never ran.
    const failedAt = new Date().toISOString();
    await database.batch([
      database
        .prepare(
          `UPDATE migration_runs
           SET state = 'failed', failure_category = 'infrastructure',
               failure_code = 'verification_dispatch_failed',
               completed_at = ?, updated_at = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .bind(failedAt, failedAt, runId, input.organizationId),
      database
        .prepare(
          `UPDATE repository_migrations
           SET state = 'merged', last_failure_category = 'infrastructure',
               updated_at = ?
           WHERE id = ? AND organization_id = ? AND state = 'assessing'`,
        )
        .bind(failedAt, context.migrationId, input.organizationId),
    ]);
    return null;
  }
  return { runId };
}
