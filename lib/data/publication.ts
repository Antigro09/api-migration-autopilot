import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import {
  parseRunManifestV1,
  type JsonObject,
  type RunManifestV1,
  type TenantContext,
} from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import { GitHubAppGateway } from "@/lib/integrations/github";
import type { FileEdit } from "@/lib/migration/contracts";
import { createPatchHash } from "@/lib/migration/patch-security";
import { readRunArtifact } from "./artifacts";
import { appendAuditEvent } from "./control-plane";

export type ApprovalIntent = "open-draft-pr";

export type PatchRecord = {
  patchId: string;
  artifactId: string;
  baseSha: string;
  sha256: string;
  sizeBytes: number;
  integrityChecks: {
    valid: boolean;
    controlPlaneValid?: boolean;
    workerValid?: boolean;
    issues?: Array<{ code: string; path?: string; message: string; source?: string }>;
    additions?: number;
    deletions?: number;
    fileCount?: number;
    unresolvedFindingIds?: string[];
  };
};

type RunRecord = {
  organizationId: string;
  repositoryMigrationId: string;
  repositoryId: string;
  campaignId: string;
  campaignSlug: string;
  campaignName: string;
  state: string;
  baseSha: string;
  patchSha256: string | null;
  approvedPatchSha256: string | null;
  approvedAt: string | null;
  manifest: string | null;
  participantId: string;
  githubRepositoryId: string;
  owner: string;
  repository: string;
  defaultBranch: string;
  patcherInstallationId: string | null;
  patcherStatus: string | null;
};

function isoNow(): string {
  return new Date().toISOString();
}

function assertApprover(tenant: TenantContext): void {
  if (
    tenant.organizationKind !== "customer" ||
    !["admin", "approver"].includes(tenant.role)
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "Only an approver or admin in the customer organization can approve or publish a patch.",
    );
  }
}

async function loadRun(
  organizationId: string,
  runId: string,
): Promise<RunRecord> {
  const run = await getD1()
    .prepare(
      `SELECT
        mr.organization_id AS organizationId,
        mr.repository_migration_id AS repositoryMigrationId,
        mr.repository_id AS repositoryId,
        mr.campaign_id AS campaignId,
        c.slug AS campaignSlug,
        c.name AS campaignName,
        mr.state,
        mr.base_sha AS baseSha,
        mr.patch_sha256 AS patchSha256,
        mr.approved_patch_sha256 AS approvedPatchSha256,
        mr.approved_at AS approvedAt,
        mr.manifest,
        rm.campaign_participant_id AS participantId,
        r.github_repository_id AS githubRepositoryId,
        r.owner,
        r.name AS repository,
        r.default_branch AS defaultBranch,
        gip.github_installation_id AS patcherInstallationId,
        gip.status AS patcherStatus
       FROM migration_runs mr
       JOIN repository_migrations rm ON rm.id = mr.repository_migration_id
       JOIN campaigns c ON c.id = mr.campaign_id
       JOIN repositories r ON r.id = mr.repository_id
       LEFT JOIN github_installations gip ON gip.id = r.patcher_installation_id
       WHERE mr.id = ? AND mr.organization_id = ? AND mr.kind = 'patch'
       LIMIT 1`,
    )
    .bind(runId, organizationId)
    .first<RunRecord>();
  if (!run) {
    throw new DomainError(
      "NOT_FOUND",
      "The patch run was not found in this organization.",
    );
  }
  return run;
}

export async function loadPatchRecord(
  organizationId: string,
  runId: string,
): Promise<PatchRecord> {
  const patch = await getD1()
    .prepare(
      `SELECT
        id AS patchId,
        artifact_id AS artifactId,
        base_sha AS baseSha,
        sha256,
        size_bytes AS sizeBytes,
        integrity_checks AS integrityChecks
       FROM patches
       WHERE organization_id = ? AND run_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(organizationId, runId)
    .first<Omit<PatchRecord, "integrityChecks"> & { integrityChecks: string }>();
  if (!patch) {
    throw new DomainError("NOT_FOUND", "No generated patch exists for this run.");
  }
  let integrityChecks: PatchRecord["integrityChecks"];
  try {
    integrityChecks = JSON.parse(patch.integrityChecks) as PatchRecord["integrityChecks"];
  } catch {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The persisted patch integrity record could not be read.",
    );
  }
  return { ...patch, integrityChecks };
}

/**
 * Reads the persisted patch and re-derives its canonical hash from the exact
 * stored bytes. Approval and publication both go through this, so neither can
 * act on a hash that was merely reported earlier.
 */
export async function readPersistedPatch(
  organizationId: string,
  runId: string,
): Promise<{ record: PatchRecord; files: FileEdit[]; recomputedSha256: string }> {
  await ensureDatabaseSchema();
  const record = await loadPatchRecord(organizationId, runId);
  const plaintext = await readRunArtifact({
    organizationId,
    artifactId: record.artifactId,
  });
  let parsed: { baseSha?: unknown; files?: unknown };
  try {
    parsed = JSON.parse(plaintext) as { baseSha?: unknown; files?: unknown };
  } catch {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The stored patch artifact is not readable JSON.",
    );
  }
  if (
    typeof parsed.baseSha !== "string" ||
    parsed.baseSha.toLowerCase() !== record.baseSha.toLowerCase() ||
    !Array.isArray(parsed.files)
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The stored patch artifact does not match its database record.",
    );
  }
  const files = parsed.files as FileEdit[];
  const recomputedSha256 = await createPatchHash(record.baseSha, files);
  if (recomputedSha256 !== record.sha256) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The stored patch content does not match its recorded hash.",
    );
  }
  return { record, files, recomputedSha256 };
}

export async function approvePatch(input: {
  tenant: TenantContext;
  runId: string;
  patchHash: string;
  intent: ApprovalIntent;
}): Promise<{ approvedPatchSha256: string; warned: boolean }> {
  await ensureDatabaseSchema();
  assertApprover(input.tenant);
  if (input.intent !== "open-draft-pr") {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The only supported approval intent is open-draft-pr.",
    );
  }
  if (!/^[a-f0-9]{64}$/i.test(input.patchHash)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The approval must carry the exact 64-character patch hash.",
    );
  }

  const run = await loadRun(input.tenant.organizationId, input.runId);
  if (
    !["awaiting_review", "validation_failed", "validation_incomplete"].includes(
      run.state,
    )
  ) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      `A run in state ${run.state} cannot be approved.`,
    );
  }

  const { record, recomputedSha256 } = await readPersistedPatch(
    input.tenant.organizationId,
    input.runId,
  );
  if (recomputedSha256.toLowerCase() !== input.patchHash.toLowerCase()) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The approved hash does not match the patch currently stored for this run. Reload the diff and approve the hash shown.",
    );
  }
  if (!record.integrityChecks.valid) {
    throw new DomainError(
      "FORBIDDEN",
      "This patch failed integrity, allowed-path, base-SHA, or syntax validation and can never be published.",
      {
        issues: (record.integrityChecks.issues ?? []).slice(0, 20),
      },
    );
  }

  const warned = run.state !== "awaiting_review";
  const now = isoNow();
  const database = getD1();
  await database.batch([
    database
      .prepare(
        `UPDATE migration_runs
         SET state = 'approved', approved_patch_sha256 = ?,
             approved_by_membership_id = ?, approved_at = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND state = ?`,
      )
      .bind(
        recomputedSha256,
        input.tenant.membershipId,
        now,
        now,
        input.runId,
        input.tenant.organizationId,
        run.state,
      ),
    database
      .prepare(
        `UPDATE patches
         SET approved_at = ?, approved_by_membership_id = ?
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(now, input.tenant.membershipId, record.patchId, input.tenant.organizationId),
    database
      .prepare(
        `UPDATE repository_migrations
         SET state = 'approved_for_pr', updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(now, run.repositoryMigrationId, input.tenant.organizationId),
  ]);

  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "run",
    aggregateId: input.runId,
    action: "patch.approved",
    actorMembershipId: input.tenant.membershipId,
    payload: {
      patchSha256: recomputedSha256,
      intent: input.intent,
      approvedFromState: run.state,
      warnedApproval: warned,
    },
  });
  return { approvedPatchSha256: recomputedSha256, warned };
}

export async function publishApprovedPatch(input: {
  tenant: TenantContext;
  runId: string;
}): Promise<{
  number: number;
  url: string;
  branch: string;
  existing: boolean;
}> {
  await ensureDatabaseSchema();
  assertApprover(input.tenant);
  const run = await loadRun(input.tenant.organizationId, input.runId);

  // Idempotent retry: a run already published returns its recorded identity.
  if (run.state === "pr_open" || run.state === "merged" || run.state === "verified") {
    const manifest = run.manifest
      ? (JSON.parse(run.manifest) as RunManifestV1)
      : null;
    if (manifest?.pullRequest) {
      return {
        number: manifest.pullRequest.number,
        url: manifest.pullRequest.url,
        branch: manifest.pullRequest.branch,
        existing: true,
      };
    }
  }
  if (!["approved", "publishing"].includes(run.state)) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      `A run in state ${run.state} cannot open a draft pull request.`,
    );
  }
  if (!run.approvedPatchSha256) {
    throw new DomainError(
      "FORBIDDEN",
      "The run has no recorded exact-hash approval.",
    );
  }
  if (!run.patcherInstallationId || run.patcherStatus !== "active") {
    throw new DomainError(
      "FORBIDDEN",
      "The Patcher App installation for this repository is not active.",
    );
  }

  const { record, files, recomputedSha256 } = await readPersistedPatch(
    input.tenant.organizationId,
    input.runId,
  );
  if (!record.integrityChecks.valid) {
    throw new DomainError(
      "FORBIDDEN",
      "The patch no longer passes integrity validation and cannot be published.",
    );
  }
  if (recomputedSha256.toLowerCase() !== run.approvedPatchSha256.toLowerCase()) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The stored patch no longer matches the approved hash. Approval must be repeated.",
    );
  }

  const gateway = new GitHubAppGateway();
  // Re-read the branch head immediately before the write; a moved default
  // branch invalidates the approval rather than silently rebasing.
  const currentSha = await gateway.getBranchSha({
    appKind: "patcher",
    installationId: Number(run.patcherInstallationId),
    repositoryId: Number(run.githubRepositoryId),
    owner: run.owner,
    repository: run.repository,
    branch: run.defaultBranch,
  });
  if (currentSha.toLowerCase() !== run.baseSha.toLowerCase()) {
    await getD1()
      .prepare(
        `UPDATE migration_runs
         SET failure_category = 'stale_base', failure_code = 'default_branch_moved',
             updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(isoNow(), input.runId, input.tenant.organizationId)
      .run();
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The default branch moved after approval. Generate and approve a fresh patch against the current commit.",
    );
  }

  const database = getD1();
  await database
    .prepare(
      `UPDATE migration_runs SET state = 'publishing', updated_at = ?
       WHERE id = ? AND organization_id = ? AND state IN ('approved', 'publishing')`,
    )
    .bind(isoNow(), input.runId, input.tenant.organizationId)
    .run();

  let pullRequest;
  try {
    pullRequest = await gateway.publishDraftPullRequest({
      installationId: Number(run.patcherInstallationId),
      repositoryId: Number(run.githubRepositoryId),
      owner: run.owner,
      repository: run.repository,
      defaultBranch: run.defaultBranch,
      campaignSlug: run.campaignSlug,
      runId: input.runId,
      baseSha: run.baseSha,
      approvedPatchSha256: run.approvedPatchSha256,
      files,
      title: `Migrate ${run.campaignName}`,
      body: draftPullRequestBody({
        campaignName: run.campaignName,
        runId: input.runId,
        patchSha256: recomputedSha256,
        integrity: record.integrityChecks,
        manifest: run.manifest ? (JSON.parse(run.manifest) as RunManifestV1) : null,
      }),
    });
  } catch (error) {
    await database
      .prepare(
        `UPDATE migration_runs
         SET state = 'approved', failure_category = 'permission',
             failure_code = 'publication_failed', updated_at = ?
         WHERE id = ? AND organization_id = ? AND state = 'publishing'`,
      )
      .bind(isoNow(), input.runId, input.tenant.organizationId)
      .run();
    throw error;
  }

  const now = isoNow();
  const manifest: RunManifestV1 | null = run.manifest
    ? (JSON.parse(run.manifest) as RunManifestV1)
    : null;
  // Re-validated so a finalized manifest can never drift from the contract.
  const finalized: RunManifestV1 | null = manifest
    ? parseRunManifestV1({
        ...manifest,
        approval: {
          patchSha256: recomputedSha256,
          approvedByMembershipId: input.tenant.membershipId,
          approvedAt: run.approvedAt ?? now,
        },
        pullRequest: {
          provider: "github",
          number: pullRequest.number,
          url: pullRequest.url,
          branch: pullRequest.branch,
          draft: true,
        },
        timestamps: { ...manifest.timestamps, completedAt: now },
      })
    : null;

  await database.batch([
    database
      .prepare(
        `UPDATE migration_runs
         SET state = 'pr_open', manifest = COALESCE(?, manifest), updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(
        finalized ? JSON.stringify(finalized) : null,
        now,
        input.runId,
        input.tenant.organizationId,
      ),
    database
      .prepare(
        `UPDATE repository_migrations
         SET state = 'draft_pr_open', updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(now, run.repositoryMigrationId, input.tenant.organizationId),
    database
      .prepare(
        `UPDATE campaign_participants
         SET lifecycle_status = 'pr_opened', updated_at = ?
         WHERE id = ? AND share_lifecycle_with_provider = true`,
      )
      .bind(now, run.participantId),
  ]);

  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "run",
    aggregateId: input.runId,
    action: "patch.draft_pr_published",
    actorMembershipId: input.tenant.membershipId,
    payload: {
      patchSha256: recomputedSha256,
      pullRequestNumber: pullRequest.number,
      branch: pullRequest.branch,
      existing: pullRequest.existing,
      baseSha: run.baseSha,
    },
  });

  return pullRequest;
}

function draftPullRequestBody(input: {
  campaignName: string;
  runId: string;
  patchSha256: string;
  integrity: PatchRecord["integrityChecks"];
  manifest: RunManifestV1 | null;
}): string {
  const validation = input.manifest?.validationResults ?? [];
  const failed = validation.filter((entry) => entry.outcome === "failed");
  const incomplete = validation.filter(
    (entry) => entry.outcome === "incomplete" || entry.outcome === "not_run",
  );
  const lines = [
    `Automated migration for **${input.campaignName}**.`,
    "",
    "This pull request is a **draft**. It was opened by API Migration Autopilot after a",
    "member of this organization approved the exact patch hash below. Nothing is merged",
    "automatically and no workflow files were touched.",
    "",
    `- Run: \`${input.runId}\``,
    `- Approved patch SHA-256: \`${input.patchSha256}\``,
    `- Files changed: ${input.integrity.fileCount ?? 0}`,
    "",
  ];
  if (failed.length > 0) {
    lines.push(
      "> [!WARNING]",
      "> Declared validation commands **failed** for this patch and it was approved anyway:",
      ...failed.map((entry) => `> - \`${entry.command}\``),
      "",
    );
  }
  if (incomplete.length > 0) {
    lines.push(
      "> [!WARNING]",
      "> Validation is **incomplete**; these commands did not produce a pass/fail result:",
      ...incomplete.map(
        (entry) => `> - \`${entry.command}\` — ${entry.summary}`,
      ),
      "",
    );
  }
  if (validation.length > 0 && failed.length === 0 && incomplete.length === 0) {
    lines.push(
      "Declared validation commands passed in an isolated, offline sandbox:",
      ...validation.map((entry) => `- \`${entry.command}\``),
      "",
    );
  }
  const unresolved = input.integrity.unresolvedFindingIds ?? [];
  if (unresolved.length > 0) {
    lines.push(
      `${unresolved.length} finding(s) were **not** auto-migrated and still need manual review.`,
      "",
    );
  }
  lines.push("Review every hunk before marking this pull request ready.");
  return lines.join("\n");
}

export function integrityIssueSummary(record: PatchRecord): JsonObject {
  return {
    valid: record.integrityChecks.valid,
    issueCount: (record.integrityChecks.issues ?? []).length,
  };
}
