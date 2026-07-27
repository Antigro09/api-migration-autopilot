import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import { DomainError } from "@/lib/domain/errors";
import type {
  GitHubAppKind,
  GitHubInstallation,
  GitHubRepository,
} from "@/lib/integrations/github";
import { enqueueVerificationScan } from "./assessments";

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function saveGitHubInstallation(input: {
  organizationId: string;
  appKind: GitHubAppKind;
  installation: GitHubInstallation;
  repositories: readonly GitHubRepository[];
}): Promise<{ installationId: string; repositoryCount: number }> {
  await ensureDatabaseSchema();
  const database = getD1();
  const githubInstallationId = String(input.installation.id);
  const existing = await database
    .prepare(
      `SELECT id, organization_id AS organizationId
       FROM github_installations
       WHERE app_kind = ? AND github_installation_id = ?
       LIMIT 1`,
    )
    .bind(input.appKind, githubInstallationId)
    .first<{ id: string; organizationId: string }>();
  if (existing && existing.organizationId !== input.organizationId) {
    throw new DomainError(
      "FORBIDDEN",
      "This GitHub App installation is already linked to another organization.",
    );
  }
  const installationId = existing?.id ?? id("ghi");
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO github_installations (
        id, organization_id, app_kind, github_installation_id,
        github_account_id, github_account_login, permissions, status,
        installed_at, suspended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_kind, github_installation_id) DO UPDATE SET
        github_account_id = excluded.github_account_id,
        github_account_login = excluded.github_account_login,
        permissions = excluded.permissions,
        status = excluded.status,
        suspended_at = excluded.suspended_at,
        updated_at = ?`,
    )
    .bind(
      installationId,
      input.organizationId,
      input.appKind,
      githubInstallationId,
      String(input.installation.account.id),
      input.installation.account.login,
      JSON.stringify(input.installation.permissions),
      input.installation.suspendedAt ? "suspended" : "active",
      now,
      input.installation.suspendedAt,
      now,
    )
    .run();

  let repositoryCount = 0;
  for (const repository of input.repositories) {
    if (input.appKind === "scanner") {
      await database
        .prepare(
          `INSERT INTO repositories (
            id, organization_id, scanner_installation_id,
            github_repository_id, owner, name, default_branch,
            selected, archived
          ) VALUES (?, ?, ?, ?, ?, ?, ?, true, ?)
          ON CONFLICT(organization_id, github_repository_id) DO UPDATE SET
            scanner_installation_id = excluded.scanner_installation_id,
            owner = excluded.owner,
            name = excluded.name,
            default_branch = excluded.default_branch,
            selected = true,
            archived = excluded.archived,
            updated_at = ?`,
        )
        .bind(
          id("repo"),
          input.organizationId,
          installationId,
          String(repository.id),
          repository.owner,
          repository.name,
          repository.defaultBranch,
          repository.archived,
          now,
        )
        .run();
      repositoryCount += 1;
    } else {
      const result = await database
        .prepare(
          `UPDATE repositories
           SET patcher_installation_id = ?, updated_at = ?
           WHERE organization_id = ? AND github_repository_id = ?`,
        )
        .bind(
          installationId,
          now,
          input.organizationId,
          String(repository.id),
        )
        .run();
      repositoryCount += result.meta.changes;
    }
  }
  return { installationId, repositoryCount };
}

export async function recordWebhookDelivery(input: {
  deliveryId: string;
  appKind: GitHubAppKind;
  eventName: string;
  action?: string;
  installationId?: string;
}): Promise<"recorded" | "duplicate"> {
  await ensureDatabaseSchema();
  const result = await getD1()
    .prepare(
      `INSERT OR IGNORE INTO github_webhook_deliveries (
        delivery_id, app_kind, event_name, action, installation_id
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      input.deliveryId,
      input.appKind,
      input.eventName,
      input.action ?? null,
      input.installationId ?? null,
    )
    .run();
  return result.meta.changes === 0 ? "duplicate" : "recorded";
}

export async function markWebhookProcessed(
  deliveryId: string,
  errorCode?: string,
): Promise<void> {
  await ensureDatabaseSchema();
  await getD1()
    .prepare(
      `UPDATE github_webhook_deliveries
       SET processed_at = ?, processing_error_code = ?
       WHERE delivery_id = ?`,
    )
    .bind(new Date().toISOString(), errorCode ?? null, deliveryId)
    .run();
}

export async function updateInstallationFromWebhook(input: {
  appKind: GitHubAppKind;
  installationId: string;
  action: string;
}): Promise<void> {
  await ensureDatabaseSchema();
  const now = new Date().toISOString();
  if (input.action === "suspend") {
    await getD1()
      .prepare(
        `UPDATE github_installations
         SET status = 'suspended', suspended_at = ?, updated_at = ?
         WHERE app_kind = ? AND github_installation_id = ?`,
      )
      .bind(now, now, input.appKind, input.installationId)
      .run();
  } else if (input.action === "unsuspend") {
    await getD1()
      .prepare(
        `UPDATE github_installations
         SET status = 'active', suspended_at = null, updated_at = ?
         WHERE app_kind = ? AND github_installation_id = ?`,
      )
      .bind(now, input.appKind, input.installationId)
      .run();
  } else if (input.action === "deleted") {
    await getD1()
      .prepare(
        `UPDATE github_installations
         SET status = 'revoked', revoked_at = ?, updated_at = ?
         WHERE app_kind = ? AND github_installation_id = ?`,
      )
      .bind(now, now, input.appKind, input.installationId)
      .run();
  }
}

export async function applyPullRequestLifecycle(input: {
  installationId: string;
  repositoryId: string;
  pullRequestNumber: number;
  headBranch: string;
  action: string;
  merged: boolean;
  mergeCommitSha?: string;
  requestUrl?: string;
}): Promise<number> {
  await ensureDatabaseSchema();
  if (!input.headBranch.startsWith("migration-autopilot/")) return 0;
  const database = getD1();
  const run = await database
    .prepare(
      `SELECT
        mr.id,
        mr.organization_id AS organizationId,
        mr.repository_migration_id AS repositoryMigrationId,
        mr.state,
        mr.verification_run_id AS verificationRunId
       FROM migration_runs mr
       JOIN repositories r ON r.id = mr.repository_id
       JOIN github_installations gi ON gi.id = r.patcher_installation_id
       WHERE r.github_repository_id = ?
          AND gi.app_kind = 'patcher'
          AND gi.github_installation_id = ?
          AND gi.status = 'active'
          AND json_extract(mr.manifest, '$.pullRequest.number') = ?
          AND json_extract(mr.manifest, '$.pullRequest.branch') = ?
       ORDER BY mr.created_at DESC
       LIMIT 1`,
    )
    .bind(
      input.repositoryId,
      input.installationId,
      input.pullRequestNumber,
      input.headBranch,
    )
    .first<{
      id: string;
      organizationId: string;
      repositoryMigrationId: string;
      state: string;
      verificationRunId: string | null;
    }>();
  if (!run) return 0;

  const now = new Date().toISOString();
  if (input.merged) {
    if (
      !input.mergeCommitSha ||
      !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(input.mergeCommitSha)
    ) {
      return 0;
    }
    if (run.verificationRunId) return 0;
    if (run.state !== "pr_open" && run.state !== "merged") return 0;
    if (run.state === "pr_open") {
      const claim = await database
        .prepare(
          `UPDATE migration_runs
           SET state = 'merged', merge_commit_sha = ?, completed_at = ?,
               updated_at = ?
           WHERE id = ? AND organization_id = ? AND state = 'pr_open'
             AND verification_run_id IS NULL`,
        )
        .bind(
          input.mergeCommitSha.toLowerCase(),
          now,
          now,
          run.id,
          run.organizationId,
        )
        .run();
      if (claim.meta.changes === 0) return 0;
    }
    await database.batch([
      database
        .prepare(
          "UPDATE repository_migrations SET state = 'merged', updated_at = ? WHERE id = ? AND organization_id = ?",
        )
        .bind(now, run.repositoryMigrationId, run.organizationId),
      database
        .prepare(
          `UPDATE campaign_participants
           SET lifecycle_status = 'merged', updated_at = ?
           WHERE id = (
             SELECT campaign_participant_id
             FROM repository_migrations
             WHERE id = ? AND organization_id = ?
           ) AND share_lifecycle_with_provider = true`,
        )
        .bind(now, run.repositoryMigrationId, run.organizationId),
    ]);
    if (input.requestUrl) {
      await enqueueVerificationScan({
        organizationId: run.organizationId,
        repositoryMigrationId: run.repositoryMigrationId,
        mergedRunId: run.id,
        mergeCommitSha: input.mergeCommitSha,
        requestUrl: input.requestUrl,
      });
    }
    return 1;
  }

  if (input.action === "closed" && run.state === "pr_open") {
    await database.batch([
      database
        .prepare(
          "UPDATE migration_runs SET state = 'cleanup_pending', completed_at = ?, updated_at = ? WHERE id = ? AND organization_id = ?",
        )
        .bind(now, now, run.id, run.organizationId),
      database
        .prepare(
          "UPDATE repository_migrations SET state = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND organization_id = ?",
        )
        .bind(now, now, run.repositoryMigrationId, run.organizationId),
    ]);
    return 1;
  }
  return 0;
}
