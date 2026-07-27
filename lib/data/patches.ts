import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import {
  canTransitionRepositoryMigration,
  assertStateTransition,
  parseRunManifestV1,
  type JsonObject,
  type JsonValue,
  type MigrationSpecV1,
  type RepositoryMigrationState,
  type RunStage,
  type TenantContext,
} from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import { GitHubAppGateway } from "@/lib/integrations/github";
import { validatePatchEnvelope } from "@/lib/migration/patch-security";
import type { PatchRunResult, ValidationCategory } from "@/lib/migration/patch-validation";
import { VALIDATION_CATEGORIES } from "@/lib/migration/patch-validation";
import { publicAppUrl } from "@/lib/platform/config";
import { TriggerWorkflowEngine } from "@/lib/workflows/engine";
import { storeRunArtifact } from "./artifacts";
import { activeConsent } from "./consent";
import { appendAuditEvent } from "./control-plane";
import { enqueueRunArtifactDeletion } from "./retention";

export type PatchWorkPacket = {
  runId: string;
  organizationId: string;
  repositoryMigrationId: string;
  scannerInstallationId: number;
  githubRepositoryId: number;
  owner: string;
  repository: string;
  defaultBranch: string;
  baseSha: string;
  campaignId: string;
  campaignSlug: string;
  specId: string;
  specRevision: number;
  packageName: string;
  spec: MigrationSpecV1;
  allowedPaths: string[];
  validationCategories: ValidationCategory[];
  modelProcessingAllowed: boolean;
  consentPolicyVersion: string | null;
  alreadyCompleted: boolean;
};

export type PatchSummary = {
  runId: string;
  state: string;
  baseSha: string;
  patchSha256: string | null;
  approvedPatchSha256: string | null;
  approvedAt: string | null;
  integrityValid: boolean;
  integrityIssues: Array<{ code: string; path?: string; message: string }>;
  fileCount: number;
  additions: number;
  deletions: number;
  sizeBytes: number;
  publishable: boolean;
  warnRequired: boolean;
};

/** States a patch run may be requested from. */
const PATCH_REQUEST_STATES: readonly RepositoryMigrationState[] = [
  "impact_found",
  "partial_coverage",
  "patcher_required",
  "ready_for_review",
  "validation_failed",
  "validation_incomplete",
];

const PATCH_ARTIFACT_KEY = (runId: string) => `runs/${runId}/patch.json`;
const LOG_ARTIFACT_KEY = (runId: string, category: string) =>
  `runs/${runId}/logs/${category}.log`;
const MANIFEST_ARTIFACT_KEY = (runId: string) => `runs/${runId}/manifest.json`;

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function isoNow(): string {
  return new Date().toISOString();
}

export function parseValidationCategories(value: unknown): ValidationCategory[] {
  const raw =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value
        : [];
  const selected = new Set<ValidationCategory>();
  for (const entry of raw) {
    const normalized = String(entry).trim();
    if (normalized === "install") continue; // implied by every validation run
    if ((VALIDATION_CATEGORIES as readonly string[]).includes(normalized)) {
      selected.add(normalized as ValidationCategory);
    }
  }
  if (selected.size === 0) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Confirm at least one package validation script (lint, typecheck, build, or test).",
    );
  }
  return [...selected];
}

export async function recordRunStage(input: {
  organizationId: string;
  runId: string;
  stage: RunStage;
  status: "started" | "completed" | "skipped" | "failed";
  detail?: JsonObject;
}): Promise<void> {
  await ensureDatabaseSchema();
  const database = getD1();
  const previous = await database
    .prepare(
      "SELECT sequence FROM run_stage_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1",
    )
    .bind(input.runId)
    .first<{ sequence: number }>();
  await database
    .prepare(
      `INSERT OR IGNORE INTO run_stage_events (
        id, organization_id, run_id, sequence, stage, status, detail, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id("stg"),
      input.organizationId,
      input.runId,
      (previous?.sequence ?? 0) + 1,
      input.stage,
      input.status,
      JSON.stringify(input.detail ?? {}),
      isoNow(),
    )
    .run();
}

export async function listRunStages(
  organizationId: string,
  runId: string,
): Promise<
  Array<{
    sequence: number;
    stage: RunStage;
    status: string;
    detail: JsonObject;
    occurredAt: string;
  }>
> {
  await ensureDatabaseSchema();
  const result = await getD1()
    .prepare(
      `SELECT sequence, stage, status, detail, occurred_at AS occurredAt
       FROM run_stage_events
       WHERE organization_id = ? AND run_id = ?
       ORDER BY sequence ASC
       LIMIT 200`,
    )
    .bind(organizationId, runId)
    .all<{
      sequence: number;
      stage: RunStage;
      status: string;
      detail: string;
      occurredAt: string;
    }>();
  return result.results.map((row) => ({
    sequence: row.sequence,
    stage: row.stage,
    status: row.status,
    detail: (() => {
      try {
        return JSON.parse(row.detail) as JsonObject;
      } catch {
        return {} as JsonObject;
      }
    })(),
    occurredAt: row.occurredAt,
  }));
}

type PatchContextRow = {
  migrationId: string;
  migrationState: RepositoryMigrationState;
  campaignId: string;
  campaignSlug: string;
  campaignStatus: string;
  packageName: string;
  participantId: string;
  specId: string;
  specRevision: number;
  specStatus: string;
  repositoryId: string;
  githubRepositoryId: string;
  owner: string;
  repository: string;
  defaultBranch: string;
  scannerInstallationId: string;
  scannerStatus: string;
  patcherInstallationId: string | null;
  patcherStatus: string | null;
};

async function loadPatchContext(
  organizationId: string,
  repositoryMigrationId: string,
): Promise<PatchContextRow> {
  const context = await getD1()
    .prepare(
      `SELECT
        rm.id AS migrationId,
        rm.state AS migrationState,
        rm.campaign_id AS campaignId,
        rm.campaign_participant_id AS participantId,
        c.slug AS campaignSlug,
        c.status AS campaignStatus,
        c.package_name AS packageName,
        ms.id AS specId,
        ms.revision AS specRevision,
        ms.status AS specStatus,
        r.id AS repositoryId,
        r.github_repository_id AS githubRepositoryId,
        r.owner,
        r.name AS repository,
        r.default_branch AS defaultBranch,
        gis.github_installation_id AS scannerInstallationId,
        gis.status AS scannerStatus,
        gip.github_installation_id AS patcherInstallationId,
        gip.status AS patcherStatus
       FROM repository_migrations rm
       JOIN campaigns c ON c.id = rm.campaign_id
       JOIN migration_specs ms ON ms.id = rm.migration_spec_id
       JOIN repositories r ON r.id = rm.repository_id
       JOIN github_installations gis ON gis.id = r.scanner_installation_id
       LEFT JOIN github_installations gip ON gip.id = r.patcher_installation_id
       WHERE rm.id = ? AND rm.organization_id = ?
       LIMIT 1`,
    )
    .bind(repositoryMigrationId, organizationId)
    .first<PatchContextRow>();
  if (!context) {
    throw new DomainError(
      "NOT_FOUND",
      "The repository migration was not found in this organization.",
    );
  }
  return context;
}

/**
 * Paths the run is authorized to change. Derived only from findings the
 * customer already saw in a completed assessment, so a worker can never widen
 * its own write scope.
 */
async function authorizedPaths(
  organizationId: string,
  repositoryMigrationId: string,
): Promise<string[]> {
  const rows = await getD1()
    .prepare(
      `SELECT DISTINCT json_extract(f.details, '$.path') AS path
       FROM findings f
       JOIN migration_runs mr ON mr.id = f.run_id
       WHERE f.organization_id = ?
         AND mr.repository_migration_id = ?
         AND mr.kind = 'assessment'
         AND f.classification = 'affected'
         AND json_extract(f.details, '$.autoPatchEligible') = 1
         AND mr.id = (
           SELECT id FROM migration_runs
           WHERE organization_id = ? AND repository_migration_id = ?
             AND kind = 'assessment' AND state = 'cleaned'
           ORDER BY created_at DESC LIMIT 1
         )
       ORDER BY path
       LIMIT 500`,
    )
    .bind(
      organizationId,
      repositoryMigrationId,
      organizationId,
      repositoryMigrationId,
    )
    .all<{ path: string | null }>();
  return rows.results
    .map((row) => row.path)
    .filter((path): path is string => typeof path === "string" && path.length > 0);
}

export async function requestPatch(input: {
  tenant: TenantContext;
  repositoryMigrationId: string;
  validationCategories: ValidationCategory[];
  requestUrl: string;
}): Promise<{ runId: string; workflowRunId: string }> {
  await ensureDatabaseSchema();
  if (
    input.tenant.organizationKind !== "customer" ||
    !["admin", "operator", "approver"].includes(input.tenant.role)
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "Your organization role cannot request migration patches.",
    );
  }
  const context = await loadPatchContext(
    input.tenant.organizationId,
    input.repositoryMigrationId,
  );
  if (context.campaignStatus !== "live" || context.specStatus !== "approved") {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "The campaign and its approved specification must be live.",
    );
  }
  if (context.scannerStatus !== "active") {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "The Scanner App installation is not active for this repository.",
    );
  }
  if (!context.patcherInstallationId || context.patcherStatus !== "active") {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "Install the Patcher App for this repository before requesting a patch.",
    );
  }
  if (!PATCH_REQUEST_STATES.includes(context.migrationState)) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      `A patch cannot be requested while the migration is ${context.migrationState.replaceAll("_", " ")}.`,
    );
  }
  const allowedPaths = await authorizedPaths(
    input.tenant.organizationId,
    input.repositoryMigrationId,
  );
  if (allowedPaths.length === 0) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "No auto-patchable findings are recorded for this migration, so no path may be changed.",
    );
  }

  const gateway = new GitHubAppGateway();
  const baseSha = await gateway.getBranchSha({
    appKind: "scanner",
    installationId: Number(context.scannerInstallationId),
    repositoryId: Number(context.githubRepositoryId),
    owner: context.owner,
    repository: context.repository,
    branch: context.defaultBranch,
  });

  // Walk the state machine explicitly so an unexpected source state is a
  // refusal rather than a silent overwrite.
  const path: RepositoryMigrationState[] =
    context.migrationState === "impact_found" ||
    context.migrationState === "partial_coverage"
      ? ["patcher_required", "patch_requested"]
      : ["patch_requested"];
  let cursor = context.migrationState;
  for (const next of path) {
    assertStateTransition(
      "repository_migration",
      context.migrationId,
      cursor,
      next,
      canTransitionRepositoryMigration,
    );
    cursor = next;
  }

  const runId = id("run");
  const now = isoNow();
  const database = getD1();
  await database.batch([
    database
      .prepare(
        `INSERT INTO migration_runs (
          id, organization_id, repository_migration_id, repository_id,
          campaign_id, migration_spec_id, migration_spec_revision,
          state, base_sha, kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, 'patch')`,
      )
      .bind(
        runId,
        input.tenant.organizationId,
        context.migrationId,
        context.repositoryId,
        context.campaignId,
        context.specId,
        context.specRevision,
        baseSha,
      ),
    database
      .prepare(
        `UPDATE repository_migrations
         SET state = 'patch_requested', latest_run_id = ?,
             last_failure_category = null, updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(runId, now, context.migrationId, input.tenant.organizationId),
    database
      .prepare(
        `UPDATE repositories SET last_known_sha = ?, updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(baseSha, now, context.repositoryId, input.tenant.organizationId),
    database
      .prepare(
        `UPDATE campaign_participants
         SET lifecycle_status = 'patch_requested', updated_at = ?
         WHERE id = ? AND share_lifecycle_with_provider = true`,
      )
      .bind(now, context.participantId),
  ]);

  await recordRunStage({
    organizationId: input.tenant.organizationId,
    runId,
    stage: "source_acquisition",
    status: "started",
    detail: {
      baseSha,
      allowedPathCount: allowedPaths.length,
      validationCategories: input.validationCategories.join(","),
    },
  });

  try {
    const workflow = await new TriggerWorkflowEngine().trigger({
      task: "patch-run",
      payload: {
        runId,
        controlPlaneUrl: publicAppUrl(input.requestUrl),
      },
      idempotencyKey: `patch:${runId}`,
      concurrencyKey: `repository:${context.repositoryId}`,
    });
    await database
      .prepare(
        "UPDATE migration_runs SET trigger_run_id = ?, updated_at = ? WHERE id = ? AND organization_id = ?",
      )
      .bind(workflow.id, isoNow(), runId, input.tenant.organizationId)
      .run();
    await appendAuditEvent({
      organizationId: input.tenant.organizationId,
      aggregateType: "run",
      aggregateId: runId,
      action: "patch.requested",
      actorMembershipId: input.tenant.membershipId,
      payload: {
        campaignId: context.campaignId,
        specId: context.specId,
        specRevision: context.specRevision,
        baseSha,
        allowedPathCount: allowedPaths.length,
        validationCategories: input.validationCategories.join(","),
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
           SET state = 'patcher_required',
               last_failure_category = 'infrastructure', updated_at = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .bind(now, context.migrationId, input.tenant.organizationId),
    ]);
    throw error;
  }
}

export async function patchWorkPacket(
  runId: string,
): Promise<PatchWorkPacket | null> {
  await ensureDatabaseSchema();
  const database = getD1();
  const run = await database
    .prepare(
      `SELECT
        mr.id AS runId,
        mr.organization_id AS organizationId,
        mr.repository_migration_id AS repositoryMigrationId,
        mr.base_sha AS baseSha,
        mr.state,
        mr.campaign_id AS campaignId,
        mr.migration_spec_id AS specId,
        mr.migration_spec_revision AS specRevision,
        c.slug AS campaignSlug,
        c.package_name AS packageName,
        ms.content AS specContent,
        CAST(gi.github_installation_id AS INTEGER) AS scannerInstallationId,
        CAST(r.github_repository_id AS INTEGER) AS githubRepositoryId,
        r.owner,
        r.name AS repository,
        r.default_branch AS defaultBranch
       FROM migration_runs mr
       JOIN campaigns c ON c.id = mr.campaign_id
       JOIN migration_specs ms ON ms.id = mr.migration_spec_id
       JOIN repositories r ON r.id = mr.repository_id
       JOIN github_installations gi ON gi.id = r.scanner_installation_id
       WHERE mr.id = ? AND mr.kind = 'patch'
       LIMIT 1`,
    )
    .bind(runId)
    .first<{
      runId: string;
      organizationId: string;
      repositoryMigrationId: string;
      baseSha: string;
      state: string;
      campaignId: string;
      specId: string;
      specRevision: number;
      campaignSlug: string;
      packageName: string;
      specContent: string;
      scannerInstallationId: number;
      githubRepositoryId: number;
      owner: string;
      repository: string;
      defaultBranch: string;
    }>();
  if (!run) return null;
  const terminal = ["awaiting_review", "validation_failed", "validation_incomplete", "approved", "pr_open", "merged", "verified"];
  if (terminal.includes(run.state)) {
    return null;
  }
  if (!["queued", "acquiring_source", "generating", "preparing_dependencies", "validating"].includes(run.state)) {
    return null;
  }

  const stageDetail = await database
    .prepare(
      `SELECT detail FROM run_stage_events
       WHERE run_id = ? AND stage = 'source_acquisition'
       ORDER BY sequence ASC LIMIT 1`,
    )
    .bind(runId)
    .first<{ detail: string }>();
  let validationCategories: ValidationCategory[] = ["typecheck", "build", "test"];
  try {
    const parsed = JSON.parse(stageDetail?.detail ?? "{}") as {
      validationCategories?: unknown;
    };
    if (typeof parsed.validationCategories === "string") {
      validationCategories = parseValidationCategories(parsed.validationCategories);
    }
  } catch {
    // Fall back to the conservative default set.
  }

  const allowedPaths = await authorizedPaths(
    run.organizationId,
    run.repositoryMigrationId,
  );
  const consent = await activeConsent({
    organizationId: run.organizationId,
    repositoryMigrationId: run.repositoryMigrationId,
    kind: "external_model_processing",
  });

  const startedAt = isoNow();
  await database.batch([
    database
      .prepare(
        `UPDATE migration_runs
         SET state = 'acquiring_source', started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE id = ? AND state = 'queued'`,
      )
      .bind(startedAt, startedAt, runId),
    database
      .prepare(
        `UPDATE repository_migrations
         SET state = 'generating', updated_at = ?
         WHERE id = ? AND organization_id = ? AND state = 'patch_requested'`,
      )
      .bind(startedAt, run.repositoryMigrationId, run.organizationId),
  ]);

  return {
    runId: run.runId,
    organizationId: run.organizationId,
    repositoryMigrationId: run.repositoryMigrationId,
    scannerInstallationId: run.scannerInstallationId,
    githubRepositoryId: run.githubRepositoryId,
    owner: run.owner,
    repository: run.repository,
    defaultBranch: run.defaultBranch,
    baseSha: run.baseSha,
    campaignId: run.campaignId,
    campaignSlug: run.campaignSlug,
    specId: run.specId,
    specRevision: run.specRevision,
    packageName: run.packageName,
    spec: JSON.parse(run.specContent) as MigrationSpecV1,
    allowedPaths,
    validationCategories,
    modelProcessingAllowed: Boolean(consent),
    consentPolicyVersion: consent?.policyVersion ?? null,
    alreadyCompleted: false,
  };
}

/**
 * Fresh consent check performed immediately before the worker would release a
 * snippet. A grant revoked mid-run stops model processing at this gate.
 */
export async function checkModelConsentForRun(runId: string): Promise<{
  allowed: boolean;
  policyVersion: string | null;
}> {
  await ensureDatabaseSchema();
  const run = await getD1()
    .prepare(
      `SELECT organization_id AS organizationId,
              repository_migration_id AS repositoryMigrationId
       FROM migration_runs
       WHERE id = ?
         AND state IN ('acquiring_source', 'generating', 'analyzing')
       LIMIT 1`,
    )
    .bind(runId)
    .first<{ organizationId: string; repositoryMigrationId: string }>();
  if (!run) return { allowed: false, policyVersion: null };
  const consent = await activeConsent({
    organizationId: run.organizationId,
    repositoryMigrationId: run.repositoryMigrationId,
    kind: "external_model_processing",
  });
  return {
    allowed: Boolean(consent),
    policyVersion: consent?.policyVersion ?? null,
  };
}

function summarizeEdits(
  files: PatchRunResult["files"],
): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    const before = file.originalContent.split("\n");
    const after = file.newContent.split("\n");
    const beforeCounts = new Map<string, number>();
    for (const line of before) {
      beforeCounts.set(line, (beforeCounts.get(line) ?? 0) + 1);
    }
    for (const line of after) {
      const count = beforeCounts.get(line) ?? 0;
      if (count > 0) beforeCounts.set(line, count - 1);
      else additions += 1;
    }
    for (const count of beforeCounts.values()) deletions += count;
  }
  return { additions, deletions };
}

export async function submitPatchResult(input: {
  runId: string;
  result: PatchRunResult;
}): Promise<{ state: string; integrityValid: boolean }> {
  await ensureDatabaseSchema();
  const database = getD1();
  const run = await database
    .prepare(
      `SELECT
        mr.organization_id AS organizationId,
        mr.repository_migration_id AS repositoryMigrationId,
        mr.campaign_id AS campaignId,
        mr.repository_id AS repositoryId,
        mr.migration_spec_id AS specId,
        mr.migration_spec_revision AS specRevision,
        mr.base_sha AS baseSha,
        mr.state,
        mr.created_at AS createdAt,
        mr.started_at AS startedAt,
        rm.state AS migrationState,
        rm.campaign_participant_id AS participantId
       FROM migration_runs mr
       JOIN repository_migrations rm ON rm.id = mr.repository_migration_id
       WHERE mr.id = ? AND mr.kind = 'patch'
       LIMIT 1`,
    )
    .bind(input.runId)
    .first<{
      organizationId: string;
      repositoryMigrationId: string;
      campaignId: string;
      repositoryId: string;
      specId: string;
      specRevision: number;
      baseSha: string;
      state: string;
      createdAt: string;
      startedAt: string | null;
      migrationState: RepositoryMigrationState;
      participantId: string;
    }>();
  if (!run) {
    throw new DomainError("NOT_FOUND", "The patch run was not found.");
  }
  if (
    !["acquiring_source", "generating", "preparing_dependencies", "validating"].includes(
      run.state,
    )
  ) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "The patch run is not accepting a result in its current state.",
    );
  }
  if (input.result.specRevision !== run.specRevision) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The patch was generated against a different specification revision.",
    );
  }

  const allowedPaths = await authorizedPaths(
    run.organizationId,
    run.repositoryMigrationId,
  );
  // Independent boundary validation: the worker's own verdict is recorded but
  // never trusted for the publication decision.
  const boundary = await validatePatchEnvelope({
    baseSha: input.result.baseSha,
    expectedBaseSha: run.baseSha,
    files: input.result.files,
    allowedPaths,
    expectedPatchSha256: input.result.patchSha256,
  });
  const workerIntegrityValid = Object.values(input.result.integrity).every(
    Boolean,
  );
  const integrityValid = boundary.valid && workerIntegrityValid;
  const issues = [
    ...boundary.issues.map((issue) => ({
      code: issue.code,
      ...(issue.path ? { path: issue.path } : {}),
      message: issue.message,
      source: "control-plane",
    })),
    ...input.result.workerIssues.map((issue) => ({
      code: issue.code,
      ...(issue.path ? { path: issue.path } : {}),
      message: issue.message,
      source: "worker",
    })),
  ];

  const createdAt = normalizeTimestamp(run.createdAt);
  const parsedStartedAt = normalizeTimestamp(run.startedAt ?? run.createdAt);
  const startedAt = new Date(
    Math.max(Date.parse(createdAt), Date.parse(parsedStartedAt)),
  ).toISOString();
  const now = new Date(
    Math.max(Date.now(), Date.parse(startedAt)),
  ).toISOString();
  // A patch that fails either integrity gate can never be published, so it is
  // never persisted as reviewable work: the run fails and its scratch material
  // is queued for deletion.
  if (!integrityValid) {
    assertStateTransition(
      "repository_migration",
      run.repositoryMigrationId,
      run.migrationState,
      "patcher_required",
      canTransitionRepositoryMigration,
    );
    await database.batch([
      database
        .prepare(
          `UPDATE migration_runs
           SET state = 'failed', failure_category = 'code',
               failure_code = 'patch_boundary_rejected', completed_at = ?,
               updated_at = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .bind(now, now, input.runId, run.organizationId),
      database
        .prepare(
          `UPDATE repository_migrations
           SET state = 'patcher_required', last_failure_category = 'code',
               updated_at = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .bind(now, run.repositoryMigrationId, run.organizationId),
    ]);
    await recordRunStage({
      organizationId: run.organizationId,
      runId: input.runId,
      stage: "patch_integrity",
      status: "failed",
      detail: {
        controlPlaneValid: boundary.valid,
        workerValid: workerIntegrityValid,
        issueCodes: [...new Set(issues.map((issue) => issue.code))].join(","),
      },
    });
    await enqueueRunArtifactDeletion({
      organizationId: run.organizationId,
      runId: input.runId,
      reason: "run_completed",
      hardDeadlineAt: now,
    });
    await appendAuditEvent({
      organizationId: run.organizationId,
      aggregateType: "run",
      aggregateId: input.runId,
      action: "patch.rejected",
      payload: {
        controlPlaneValid: boundary.valid,
        workerValid: workerIntegrityValid,
        issueCount: issues.length,
        issueCodes: [...new Set(issues.map((issue) => issue.code))].join(","),
      },
    });
    return { state: "failed", integrityValid: false };
  }

  const hasFailure = input.result.validation.some(
    (entry) => entry.outcome === "failed",
  );
  const hasIncomplete =
    input.result.validation.length === 0 ||
    input.result.validation.some(
      (entry) => entry.outcome === "incomplete" || entry.outcome === "not_run",
    );
  const runState = hasFailure
    ? "validation_failed"
    : hasIncomplete
      ? "validation_incomplete"
      : "awaiting_review";
  const migrationState: RepositoryMigrationState = hasFailure
    ? "validation_failed"
    : hasIncomplete
      ? "validation_incomplete"
      : "ready_for_review";
  assertStateTransition(
    "repository_migration",
    run.repositoryMigrationId,
    run.migrationState,
    migrationState,
    canTransitionRepositoryMigration,
  );

  const patchArtifact = await storeRunArtifact({
    organizationId: run.organizationId,
    runId: input.runId,
    campaignId: run.campaignId,
    kind: "patch",
    storageKey: PATCH_ARTIFACT_KEY(input.runId),
    contentType: "application/json",
    plaintext: JSON.stringify({
      baseSha: input.result.baseSha,
      patchSha256: boundary.patchSha256,
      files: input.result.files,
    }),
  });

  const logArtifactIds = new Map<string, string>();
  for (const log of input.result.validationLogs) {
    if (log.output.length === 0) continue;
    const artifact = await storeRunArtifact({
      organizationId: run.organizationId,
      runId: input.runId,
      campaignId: run.campaignId,
      kind: "validation_log",
      storageKey: LOG_ARTIFACT_KEY(input.runId, log.category),
      contentType: "text/plain",
      plaintext: log.output,
    });
    logArtifactIds.set(log.category, artifact.id);
  }

  const { additions, deletions } = summarizeEdits(input.result.files);
  const integrityChecks: JsonObject = {
    valid: integrityValid,
    controlPlaneValid: boundary.valid,
    workerValid: workerIntegrityValid,
    checks: { ...input.result.integrity },
    issues: issues as unknown as JsonValue,
    totalBytes: boundary.totalBytes,
    additions,
    deletions,
    fileCount: input.result.files.length,
    unresolvedFindingIds: input.result.unresolvedFindingIds.slice(0, 1_000),
  };

  await appendAuditEvent({
    organizationId: run.organizationId,
    aggregateType: "run",
    aggregateId: input.runId,
    action: "patch.generated",
    payload: {
      patchSha256: boundary.patchSha256,
      integrityValid,
      controlPlaneValid: boundary.valid,
      workerValid: workerIntegrityValid,
      fileCount: input.result.files.length,
      runState,
      cleanupComplete: input.result.cleanup.complete,
      modelUsed: input.result.cost.modelInputTokens > 0,
    },
  });
  const auditSummary = await auditChainSummary(
    run.organizationId,
    "run",
    input.runId,
  );

  const validationResults = input.result.validation.map((entry, index) => ({
    id: `vr${index + 1}.${entry.category}`,
    category: entry.category,
    command: entry.command,
    outcome: entry.outcome,
    ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
    durationMs: entry.durationMs,
    ...(logArtifactIds.has(entry.category)
      ? { logArtifactId: logArtifactIds.get(entry.category) as string }
      : {}),
    summary: entry.summary,
  }));

  // parseRunManifestV1 is the authoritative gate: an unparseable manifest is a
  // refusal, not a partially persisted run.
  const manifest = parseRunManifestV1({
    schemaVersion: "1",
    runId: input.runId,
    organizationId: run.organizationId,
    repositoryId: run.repositoryId,
    repositoryMigrationId: run.repositoryMigrationId,
    campaignId: run.campaignId,
    migrationSpecId: run.specId,
    migrationSpecRevision: run.specRevision,
    baseSha: run.baseSha,
    versions: input.result.versions,
    findings: input.result.findings,
    edits: input.result.edits,
    allowedPaths,
    patch: {
      sha256: boundary.patchSha256,
      sizeBytes: boundary.totalBytes,
      artifactId: patchArtifact.id,
      baseSha: run.baseSha,
    },
    integrity: input.result.integrity,
    validationResults,
    executionPolicy: input.result.executionPolicy,
    cost: input.result.cost,
    audit: auditSummary,
    timestamps: {
      createdAt,
      startedAt,
      completedAt: now,
    },
    cleanup: {
      ...input.result.cleanup,
      hardDeadlineAt: new Date(
        Date.parse(now) + 24 * 60 * 60 * 1_000,
      ).toISOString(),
    },
  });

  const statements = [
    database
      .prepare(
        `INSERT INTO patches (
          id, organization_id, run_id, artifact_id, base_sha, sha256,
          size_bytes, integrity_checks
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, sha256) DO UPDATE SET
          artifact_id = excluded.artifact_id,
          size_bytes = excluded.size_bytes,
          integrity_checks = excluded.integrity_checks`,
      )
      .bind(
        id("pch"),
        run.organizationId,
        input.runId,
        patchArtifact.id,
        input.result.baseSha,
        boundary.patchSha256,
        boundary.totalBytes,
        JSON.stringify(integrityChecks),
      ),
    database
      .prepare(
        `UPDATE migration_runs
         SET state = ?, patch_sha256 = ?, manifest = ?, manifest_sha256 = ?,
             cost_micro_usd = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(
        runState,
        boundary.patchSha256,
        JSON.stringify(manifest),
        await sha256Of(JSON.stringify(manifest)),
        Math.round(input.result.cost.modelCostUsd * 1_000_000),
        now,
        now,
        input.runId,
        run.organizationId,
      ),
    database
      .prepare(
        `UPDATE repository_migrations
         SET state = ?, latest_run_id = ?, updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(
        migrationState,
        input.runId,
        now,
        run.repositoryMigrationId,
        run.organizationId,
      ),
  ];
  for (const entry of validationResults) {
    statements.push(
      database
        .prepare(
          `INSERT INTO validation_results (
            id, organization_id, run_id, category, command, outcome,
            exit_code, duration_ms, log_artifact_id, summary
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id("vld"),
          run.organizationId,
          input.runId,
          entry.category,
          entry.command,
          entry.outcome,
          entry.exitCode ?? null,
          entry.durationMs,
          entry.logArtifactId ?? null,
          entry.summary.slice(0, 1_000),
        ),
    );
  }
  await database.batch(statements);

  await storeRunArtifact({
    organizationId: run.organizationId,
    runId: input.runId,
    campaignId: run.campaignId,
    kind: "run_manifest",
    storageKey: MANIFEST_ARTIFACT_KEY(input.runId),
    contentType: "application/json",
    plaintext: JSON.stringify(manifest),
  });

  await recordRunStage({
    organizationId: run.organizationId,
    runId: input.runId,
    stage: "manifest_persistence",
    status: "completed",
    detail: {
      integrityValid,
      fileCount: input.result.files.length,
      runState,
    },
  });
  await recordRunStage({
    organizationId: run.organizationId,
    runId: input.runId,
    stage: "sandbox_cleanup",
    status: input.result.cleanup.complete ? "completed" : "failed",
    detail: {
      complete: input.result.cleanup.complete,
      ...(input.result.cleanup.sandboxDestroyedAt
        ? { sandboxDestroyedAt: input.result.cleanup.sandboxDestroyedAt }
        : {}),
    },
  });

  return { state: runState, integrityValid };
}

function normalizeTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? isoNow() : new Date(parsed).toISOString();
}

async function auditChainSummary(
  organizationId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<{ eventCount: number; rootHash: string }> {
  const summary = await getD1()
    .prepare(
      `SELECT COUNT(*) AS eventCount,
              (SELECT event_hash FROM audit_events
               WHERE organization_id = ? AND aggregate_type = ? AND aggregate_id = ?
               ORDER BY sequence DESC LIMIT 1) AS rootHash
       FROM audit_events
       WHERE organization_id = ? AND aggregate_type = ? AND aggregate_id = ?`,
    )
    .bind(
      organizationId,
      aggregateType,
      aggregateId,
      organizationId,
      aggregateType,
      aggregateId,
    )
    .first<{ eventCount: number; rootHash: string | null }>();
  if (!summary?.rootHash) {
    throw new DomainError(
      "AUDIT_CHAIN_INVALID",
      "The run has no audit chain to anchor its manifest.",
    );
  }
  return {
    eventCount: Number(summary.eventCount),
    rootHash: summary.rootHash,
  };
}

async function sha256Of(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function failPatchRun(
  runId: string,
  failureCode: string,
  category: "code" | "infrastructure" | "permission" | "stale_base" | "unsupported" = "infrastructure",
): Promise<void> {
  await ensureDatabaseSchema();
  const database = getD1();
  const run = await database
    .prepare(
      `SELECT organization_id AS organizationId,
              repository_migration_id AS repositoryMigrationId
       FROM migration_runs
       WHERE id = ? AND kind = 'patch'
         AND state IN ('queued', 'acquiring_source', 'generating',
                       'preparing_dependencies', 'validating', 'publishing')
       LIMIT 1`,
    )
    .bind(runId)
    .first<{ organizationId: string; repositoryMigrationId: string }>();
  if (!run) return;
  const now = isoNow();
  await database.batch([
    database
      .prepare(
        `UPDATE migration_runs
         SET state = 'failed', failure_category = ?, failure_code = ?,
             completed_at = ?, updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(
        category,
        failureCode.slice(0, 128),
        now,
        now,
        runId,
        run.organizationId,
      ),
    database
      .prepare(
        `UPDATE repository_migrations
         SET state = 'patcher_required', last_failure_category = ?, updated_at = ?
         WHERE id = ? AND organization_id = ?
           AND state IN ('patch_requested', 'generating', 'validating')`,
      )
      .bind(category, now, run.repositoryMigrationId, run.organizationId),
  ]);
  await enqueueRunArtifactDeletion({
    organizationId: run.organizationId,
    runId,
    reason: "run_completed",
    hardDeadlineAt: now,
  });
  await appendAuditEvent({
    organizationId: run.organizationId,
    aggregateType: "run",
    aggregateId: runId,
    action: "patch.failed",
    payload: { failureCode: failureCode.slice(0, 128), category },
  });
}
