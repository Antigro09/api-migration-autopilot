import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";

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
  evidence: Array<{ title: string; url: string }>;
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
      !Array.isArray(parsed.skipped) ||
      !parsed.dependency ||
      typeof parsed.dependency.packageName !== "string"
    ) {
      return null;
    }
    return parsed;
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
        (entry): entry is { title: string; url: string } =>
          Boolean(
            entry &&
              typeof entry === "object" &&
              typeof (entry as { title?: unknown }).title === "string" &&
              typeof (entry as { url?: unknown }).url === "string",
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
  };
}
