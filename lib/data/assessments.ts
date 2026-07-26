import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import { type TenantContext } from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import { GitHubAppGateway } from "@/lib/integrations/github";
import type { MigrationAssessment } from "@/lib/migration/contracts";
import { normalizeRepositoryPath } from "@/lib/migration/patch-security";
import { publicAppUrl } from "@/lib/platform/config";
import { TriggerWorkflowEngine } from "@/lib/workflows/engine";
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
  alreadyCompleted: boolean;
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
  if (context.packageName !== "stripe") {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The production alpha assessment engine currently supports the stripe package.",
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
        c.package_name AS packageName
       FROM migration_runs mr
       JOIN repositories r ON r.id = mr.repository_id
       JOIN github_installations gi ON gi.id = r.scanner_installation_id
       JOIN campaigns c ON c.id = mr.campaign_id
       WHERE mr.id = ?
         AND mr.state IN ('queued', 'acquiring_source', 'analyzing', 'cleaned')
       LIMIT 1`,
    )
    .bind(runId)
    .first<AssessmentWorkPacket>();
  if (!packet) return null;
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
  return { ...packet, alreadyCompleted: runState?.state === "cleaned" };
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
      participantId: string;
    }>();
  if (!run) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "Assessment run is not in the analyzing state.",
    );
  }
  if (
    input.assessment.specId !== "reference.stripe-node.20-to-22" ||
    input.assessment.specRevision !== 1
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
  const migrationState =
    status === "no-impact"
      ? "no_impact"
      : status === "impact-found"
        ? "impact_found"
        : "partial_coverage";
  const now = new Date().toISOString();
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
            url: citation.url,
          })),
        }),
      );
  });
  statements.push(
    database
      .prepare(
        `UPDATE repository_migrations
         SET state = ?, dependency_version = ?, assessment_summary = ?,
             last_failure_category = null, updated_at = ?
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
          skipped: allSkipped,
        }),
        now,
        run.repositoryMigrationId,
        run.organizationId,
      ),
    database
      .prepare(
        `UPDATE migration_runs
         SET state = 'cleaned', completed_at = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND state = 'analyzing'`,
      )
      .bind(now, now, input.runId, run.organizationId),
    database
      .prepare(
        `UPDATE campaign_participants
         SET lifecycle_status = ?, updated_at = ?
         WHERE id = ? AND share_lifecycle_with_provider = true`,
      )
      .bind(
        status === "no-impact" ? "assessed" : "affected",
        now,
        run.participantId,
      ),
  );
  await database.batch(statements);
  await appendAuditEvent({
    organizationId: run.organizationId,
    aggregateType: "run",
    aggregateId: input.runId,
    action: "assessment.completed",
    payload: {
      status,
      findingCount: input.assessment.findings.length,
      scannedFileCount: input.assessment.scannedFiles.length,
      skippedCount: allSkipped.length,
      sourceRetained: false,
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
