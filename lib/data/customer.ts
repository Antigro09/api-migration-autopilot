import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import type {
  JsonObject,
  MigrationSpecV1,
  RunManifestV1,
  RunStage,
} from "@/lib/domain";
import {
  MODEL_CONSENT_POLICY_VERSION,
  parseMigrationSpecV1,
  parseRunManifestV1,
} from "@/lib/domain";
import { activeConsent } from "./consent";
import { listPatchReviewFiles, loadPatchRecord } from "./publication";
import { listRunStages } from "./patches";
import {
  customerSupportAccess,
  type CustomerSupportAccess,
} from "./support";

export type CustomerRepository = {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  archived: boolean;
  patcherConnected: boolean;
};

export type CustomerInvitation = {
  id: string;
  campaignId: string;
  campaignName: string;
  providerName: string;
};

export type CustomerMigrationSummary = {
  status: "no-impact" | "impact-found" | "partial-coverage";
  findingCount: number;
  scannedFiles: number;
  scannedPaths: string[];
  skipped: Array<{ path: string; reason: string }>;
  dependency: {
    packageName: string;
    declaredRange?: string;
    resolvedVersion?: string;
    manifestPath?: string;
    lockfilePath?: string;
    supportedSource: boolean;
    targetSatisfied: boolean;
    warnings: string[];
  };
};

export type CustomerMigration = {
  id: string;
  state: string;
  latestRunId: string | null;
  runState: string | null;
  dependencyVersion: string | null;
  assessmentSummary: CustomerMigrationSummary | null;
  lastFailureCategory: string | null;
  campaignName: string;
  providerName: string;
  repositoryOwner: string;
  repositoryName: string;
  updatedAt: string;
};

export type CustomerFinding = {
  id: string;
  ruleId: string;
  classification: "affected" | "uncertain" | "unsupported";
  confidenceBasisPoints: number;
  path: string;
  message: string;
  location: {
    line: number;
    column: number;
  };
  autoPatchEligible: boolean;
  evidence: Array<{ title: string; url?: string }>;
};

export type CustomerWorkspaceData = {
  scannerConnected: boolean;
  patcherConnected: boolean;
  repositories: CustomerRepository[];
  invitations: CustomerInvitation[];
  migrations: CustomerMigration[];
  selectedMigration: CustomerMigration | null;
  selectedFindings: CustomerFinding[];
  migrationCount: number;
  supportAccess: CustomerSupportAccess;
  auditEvents: CustomerAuditEvent[];
};

export type CustomerAuditEvent = {
  id: string;
  action: string;
  aggregateType: string;
  aggregateId: string;
  actorKind: string;
  occurredAt: string;
};

type MigrationRow = Omit<CustomerMigration, "assessmentSummary"> & {
  assessmentSummary: string | null;
};

type FindingRow = Pick<
  CustomerFinding,
  "id" | "ruleId" | "classification" | "confidenceBasisPoints"
> & {
  details: string;
};

function parseAssessmentSummary(value: string | null): CustomerMigrationSummary | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as CustomerMigrationSummary;
    if (
      !parsed ||
      !["no-impact", "impact-found", "partial-coverage"].includes(
        parsed.status,
      ) ||
      !Number.isInteger(parsed.findingCount) ||
      !Number.isInteger(parsed.scannedFiles) ||
      (parsed.scannedPaths !== undefined &&
        (!Array.isArray(parsed.scannedPaths) ||
          !parsed.scannedPaths.every((path) => typeof path === "string"))) ||
      !Array.isArray(parsed.skipped) ||
      !parsed.dependency ||
      typeof parsed.dependency.packageName !== "string"
    ) {
      return null;
    }
    return {
      ...parsed,
      scannedPaths: parsed.scannedPaths ?? [],
    };
  } catch {
    return null;
  }
}

function parseFinding(input: FindingRow): CustomerFinding | null {
  try {
    const details = JSON.parse(input.details) as {
      path?: unknown;
      message?: unknown;
      location?: { line?: unknown; column?: unknown };
      autoPatchEligible?: unknown;
      evidence?: unknown;
    };
    if (
      typeof details.path !== "string" ||
      typeof details.message !== "string" ||
      typeof details.location?.line !== "number" ||
      typeof details.location.column !== "number" ||
      typeof details.autoPatchEligible !== "boolean" ||
      !Array.isArray(details.evidence)
    ) {
      return null;
    }
    const evidence = details.evidence
      .filter(
        (entry): entry is { title: string; url?: string } =>
          Boolean(
            entry &&
              typeof entry === "object" &&
              typeof (entry as { title?: unknown }).title === "string" &&
              ((entry as { url?: unknown }).url === undefined ||
                typeof (entry as { url?: unknown }).url === "string"),
          ),
      )
      .slice(0, 20);
    return {
      id: input.id,
      ruleId: input.ruleId,
      classification: input.classification,
      confidenceBasisPoints: input.confidenceBasisPoints,
      path: details.path,
      message: details.message,
      location: {
        line: details.location.line,
        column: details.location.column,
      },
      autoPatchEligible: details.autoPatchEligible,
      evidence,
    };
  } catch {
    return null;
  }
}

export async function customerWorkspaceData(
  organizationId: string,
  selectedMigrationId?: string,
): Promise<CustomerWorkspaceData> {
  await ensureDatabaseSchema();
  const database = getD1();
  const [installations, repositories, invitations, migrationRows] =
    await Promise.all([
      database
        .prepare(
          `SELECT app_kind AS appKind
           FROM github_installations
           WHERE organization_id = ? AND status = 'active'`,
        )
        .bind(organizationId)
        .all<{ appKind: "scanner" | "patcher" }>(),
      database
        .prepare(
          `SELECT
            id,
            owner,
            name,
            default_branch AS defaultBranch,
            archived,
            CASE WHEN patcher_installation_id IS NULL THEN false ELSE true END
              AS patcherConnected
           FROM repositories
           WHERE organization_id = ? AND selected = true
           ORDER BY owner, name`,
        )
        .bind(organizationId)
        .all<CustomerRepository>(),
      database
        .prepare(
          `SELECT
            ci.id,
            ci.campaign_id AS campaignId,
            c.name AS campaignName,
            o.name AS providerName
           FROM customer_invitations ci
           JOIN campaigns c ON c.id = ci.campaign_id
           JOIN organizations o ON o.id = ci.provider_organization_id
           WHERE ci.customer_organization_id = ?
             AND ci.status = 'accepted'
           ORDER BY ci.accepted_at DESC`,
        )
        .bind(organizationId)
        .all<CustomerInvitation>(),
      database
        .prepare(
          `SELECT
            rm.id,
            rm.state,
            rm.latest_run_id AS latestRunId,
            mr.state AS runState,
            rm.dependency_version AS dependencyVersion,
            rm.assessment_summary AS assessmentSummary,
            rm.last_failure_category AS lastFailureCategory,
            c.name AS campaignName,
            po.name AS providerName,
            r.owner AS repositoryOwner,
            r.name AS repositoryName,
            rm.updated_at AS updatedAt
           FROM repository_migrations rm
           JOIN campaigns c ON c.id = rm.campaign_id
           JOIN organizations po ON po.id = c.organization_id
           JOIN repositories r ON r.id = rm.repository_id
           LEFT JOIN migration_runs mr ON mr.id = rm.latest_run_id
           WHERE rm.organization_id = ? AND rm.state <> 'closed'
           ORDER BY rm.updated_at DESC
           LIMIT 100`,
        )
        .bind(organizationId)
        .all<MigrationRow>(),
    ]);
  const appKinds = new Set(installations.results.map((row) => row.appKind));
  const migrations: CustomerMigration[] = migrationRows.results.map(
    (migration) => ({
      ...migration,
      assessmentSummary: parseAssessmentSummary(migration.assessmentSummary),
    }),
  );
  const selectedMigration =
    migrations.find((migration) => migration.id === selectedMigrationId) ??
    migrations[0] ??
    null;
  const findingRows = selectedMigration?.latestRunId
    ? await database
        .prepare(
          `SELECT
            id,
            rule_id AS ruleId,
            classification,
            confidence_basis_points AS confidenceBasisPoints,
            details
           FROM findings
           WHERE organization_id = ? AND run_id = ?
           ORDER BY confidence_basis_points DESC, rule_id, id
           LIMIT 1000`,
        )
        .bind(organizationId, selectedMigration.latestRunId)
        .all<FindingRow>()
    : { results: [] as FindingRow[] };
  const [supportAccess, auditEvents] = await Promise.all([
    customerSupportAccess(organizationId),
    database
      .prepare(
        `SELECT
           ae.id,
           ae.action,
           ae.aggregate_type AS aggregateType,
           ae.aggregate_id AS aggregateId,
           COALESCE(actor_org.kind, 'system') AS actorKind,
           ae.occurred_at AS occurredAt
         FROM audit_events ae
         LEFT JOIN memberships actor ON actor.id = ae.actor_membership_id
         LEFT JOIN organizations actor_org ON actor_org.id = actor.organization_id
         WHERE ae.organization_id = ?
         ORDER BY ae.occurred_at DESC
         LIMIT 200`,
      )
      .bind(organizationId)
      .all<CustomerAuditEvent>(),
  ]);
  return {
    scannerConnected: appKinds.has("scanner"),
    patcherConnected: appKinds.has("patcher"),
    repositories: repositories.results.map((repository) => ({
      ...repository,
      archived: Boolean(repository.archived),
      patcherConnected: Boolean(repository.patcherConnected),
    })),
    invitations: invitations.results,
    migrations,
    selectedMigration,
    selectedFindings: findingRows.results
      .map(parseFinding)
      .filter((finding): finding is CustomerFinding => Boolean(finding)),
    migrationCount: migrations.length,
    supportAccess,
    auditEvents: auditEvents.results,
  };
}

export type RunStatus = {
  runId: string;
  kind: string;
  state: string;
  failureCategory: string | null;
  failureCode: string | null;
  patchSha256: string | null;
  approvedPatchSha256: string | null;
  approvedAt: string | null;
  updatedAt: string;
  stages: Array<{
    sequence: number;
    stage: RunStage;
    status: string;
    detail: JsonObject;
    occurredAt: string;
  }>;
};

/** Customer-scoped run progress derived only from persisted rows and events. */
export async function runStatus(
  organizationId: string,
  runId: string,
): Promise<RunStatus | null> {
  await ensureDatabaseSchema();
  const run = await getD1()
    .prepare(
      `SELECT
        id AS runId,
        kind,
        state,
        failure_category AS failureCategory,
        failure_code AS failureCode,
        patch_sha256 AS patchSha256,
        approved_patch_sha256 AS approvedPatchSha256,
        approved_at AS approvedAt,
        updated_at AS updatedAt
       FROM migration_runs
       WHERE id = ? AND organization_id = ?
       LIMIT 1`,
    )
    .bind(runId, organizationId)
    .first<Omit<RunStatus, "stages">>();
  if (!run) return null;
  return { ...run, stages: await listRunStages(organizationId, runId) };
}

export type PatchReviewFile = {
  path: string;
  additions: number;
  deletions: number;
  ruleIds: string[];
  transformations: Array<
    "deterministic_codemod" | "parameterized_template" | "model_residual"
  >;
  rationale: string[];
  evidence: Array<{
    ruleId: string;
    classification: "affected" | "not_affected" | "uncertain" | "unsupported";
    confidence: number;
    sources: string[];
  }>;
  knownLimitations: string[];
};

export type PatchReviewValidation = {
  category: string;
  command: string;
  outcome: string;
  exitCode: number | null;
  durationMs: number;
  summary: string;
  logAvailable: boolean;
};

export type PatchReviewData = {
  migrationId: string;
  repositoryOwner: string;
  repositoryName: string;
  campaignName: string;
  providerName: string;
  runId: string;
  runState: string;
  migrationState: string;
  baseSha: string;
  patchSha256: string;
  approvedPatchSha256: string | null;
  approvedAt: string | null;
  integrityValid: boolean;
  integrityIssues: Array<{
    code: string;
    path?: string;
    message: string;
    source?: string;
  }>;
  files: PatchReviewFile[];
  selectedPath: string | null;
  additions: number;
  deletions: number;
  unresolvedFindingCount: number;
  validation: PatchReviewValidation[];
  pullRequest: { number: number; url: string; branch: string } | null;
  modelConsentGranted: boolean;
  modelConsentPolicyVersion: string;
  publishable: boolean;
  warnRequired: boolean;
};

/**
 * Loads metadata and evidence for the review surface without decrypting any
 * changed file. A separate tenant-scoped endpoint loads one selected file.
 */
export async function customerPatchReview(
  organizationId: string,
  repositoryMigrationId: string,
  selectedPath?: string,
): Promise<PatchReviewData | null> {
  await ensureDatabaseSchema();
  const database = getD1();
  const context = await database
    .prepare(
      `SELECT
        rm.id AS migrationId,
        rm.state AS migrationState,
        r.owner AS repositoryOwner,
        r.name AS repositoryName,
        c.name AS campaignName,
        po.name AS providerName,
        mr.id AS runId,
        mr.state AS runState,
        mr.base_sha AS baseSha,
        mr.approved_patch_sha256 AS approvedPatchSha256,
        mr.approved_at AS approvedAt,
        mr.manifest,
        ms.content AS specContent
       FROM repository_migrations rm
       JOIN repositories r ON r.id = rm.repository_id
       JOIN campaigns c ON c.id = rm.campaign_id
       JOIN organizations po ON po.id = c.organization_id
       JOIN migration_runs mr ON mr.repository_migration_id = rm.id
         AND mr.kind = 'patch'
       JOIN migration_specs ms ON ms.id = mr.migration_spec_id
       WHERE rm.id = ? AND rm.organization_id = ?
       ORDER BY mr.created_at DESC
       LIMIT 1`,
    )
    .bind(repositoryMigrationId, organizationId)
    .first<{
      migrationId: string;
      migrationState: string;
      repositoryOwner: string;
      repositoryName: string;
      campaignName: string;
      providerName: string;
      runId: string;
      runState: string;
      baseSha: string;
      approvedPatchSha256: string | null;
      approvedAt: string | null;
      manifest: string | null;
      specContent: string | MigrationSpecV1;
    }>();
  if (!context) return null;

  let record;
  try {
    record = await loadPatchRecord(organizationId, context.runId);
  } catch {
    return null;
  }

  let manifest: RunManifestV1 | null = null;
  let spec: MigrationSpecV1 | null = null;
  try {
    manifest = context.manifest
      ? parseRunManifestV1(JSON.parse(context.manifest))
      : null;
  } catch {
    manifest = null;
  }
  try {
    spec = parseMigrationSpecV1(
      typeof context.specContent === "string"
        ? JSON.parse(context.specContent)
        : context.specContent,
    );
  } catch {
    spec = null;
  }

  const editsByPath = new Map<
    string,
    {
      ruleIds: string[];
      transformations: PatchReviewFile["transformations"];
      rationale: string[];
    }
  >();
  for (const edit of manifest?.edits ?? []) {
    const entry = editsByPath.get(edit.filePath) ?? {
      ruleIds: [],
      transformations: [],
      rationale: [],
    };
    if (!entry.ruleIds.includes(edit.ruleId)) entry.ruleIds.push(edit.ruleId);
    if (!entry.transformations.includes(edit.transformation)) {
      entry.transformations.push(edit.transformation);
    }
    if (!entry.rationale.includes(edit.rationale)) {
      entry.rationale.push(edit.rationale);
    }
    editsByPath.set(edit.filePath, entry);
  }
  const changesByRuleId = new Map(
    (spec?.changes ?? []).map((change) => [change.id, change]),
  );
  const sourceTitles = new Map(
    (spec?.sourceArtifacts ?? []).map((artifact) => [artifact.id, artifact.title]),
  );
  const evidenceByPath = new Map<string, PatchReviewFile["evidence"]>();
  for (const finding of manifest?.findings ?? []) {
    const change = changesByRuleId.get(finding.ruleId);
    const citedIds = new Set(finding.citationArtifactIds);
    const sources = (change?.citations ?? [])
      .filter((citation) => citedIds.has(citation.artifactId))
      .map((citation) => {
        const title = sourceTitles.get(citation.artifactId) ?? "Provider artifact";
        return citation.locator ? `${title} — ${citation.locator}` : title;
      });
    const entry = evidenceByPath.get(finding.filePath) ?? [];
    entry.push({
      ruleId: finding.ruleId,
      classification: finding.classification,
      confidence: finding.confidence,
      sources,
    });
    evidenceByPath.set(finding.filePath, entry);
  }

  const validationRows = await database
    .prepare(
      `SELECT category, command, outcome, exit_code AS exitCode,
              duration_ms AS durationMs, summary,
              log_artifact_id AS logArtifactId
       FROM validation_results
       WHERE organization_id = ? AND run_id = ?
       ORDER BY created_at ASC
       LIMIT 32`,
    )
    .bind(organizationId, context.runId)
    .all<{
      category: string;
      command: string;
      outcome: string;
      exitCode: number | null;
      durationMs: number;
      summary: string;
      logArtifactId: string | null;
    }>();

  const consent = await activeConsent({
    organizationId,
    repositoryMigrationId,
    kind: "external_model_processing",
  });

  const reviewFiles = await listPatchReviewFiles(
    organizationId,
    context.runId,
  );
  const files: PatchReviewFile[] = reviewFiles.map((file) => {
    const ruleIds = editsByPath.get(file.path)?.ruleIds ?? [];
    return {
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      ruleIds,
      transformations: editsByPath.get(file.path)?.transformations ?? [],
      rationale: editsByPath.get(file.path)?.rationale ?? [],
      evidence: evidenceByPath.get(file.path) ?? [],
      knownLimitations: [
        ...new Set(
          ruleIds.flatMap(
            (ruleId) => changesByRuleId.get(ruleId)?.knownLimitations ?? [],
          ),
        ),
      ],
    };
  });
  const resolvedPath =
    files.find((file) => file.path === selectedPath)?.path ??
    files[0]?.path ??
    null;

  const integrityValid = record.integrityChecks.valid === true;
  const warnRequired =
    context.runState === "validation_failed" ||
    context.runState === "validation_incomplete";
  return {
    migrationId: context.migrationId,
    migrationState: context.migrationState,
    repositoryOwner: context.repositoryOwner,
    repositoryName: context.repositoryName,
    campaignName: context.campaignName,
    providerName: context.providerName,
    runId: context.runId,
    runState: context.runState,
    baseSha: context.baseSha,
    patchSha256: record.sha256,
    approvedPatchSha256: context.approvedPatchSha256,
    approvedAt: context.approvedAt,
    integrityValid,
    integrityIssues: (record.integrityChecks.issues ?? []).slice(0, 50),
    files,
    selectedPath: resolvedPath,
    additions: record.integrityChecks.additions ?? 0,
    deletions: record.integrityChecks.deletions ?? 0,
    unresolvedFindingCount:
      record.integrityChecks.unresolvedFindingIds?.length ?? 0,
    validation: validationRows.results.map((row) => ({
      category: row.category,
      command: row.command,
      outcome: row.outcome,
      exitCode: row.exitCode,
      durationMs: row.durationMs,
      summary: row.summary,
      logAvailable: Boolean(row.logArtifactId),
    })),
    pullRequest: manifest?.pullRequest
      ? {
          number: manifest.pullRequest.number,
          url: manifest.pullRequest.url,
          branch: manifest.pullRequest.branch,
        }
      : null,
    modelConsentGranted: Boolean(consent),
    modelConsentPolicyVersion: MODEL_CONSENT_POLICY_VERSION,
    publishable: integrityValid && files.length > 0,
    warnRequired,
  };
}
