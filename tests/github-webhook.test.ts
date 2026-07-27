import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { resetControlPlane } from "./support/runtime";

const { getD1 } = await import("@/db");
const { handleGitHubWebhook } = await import(
  "@/lib/integrations/github-webhook"
);
const { seedPatchRun, seedTenant } = await import("./support/factory");

function signedRequest(input: {
  body: string;
  deliveryId: string;
  eventName: string;
  secret: string;
  signature?: string;
}): Request {
  return new Request(
    "https://autopilot.test/api/webhooks/github/patcher",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": input.deliveryId,
        "x-github-event": input.eventName,
        "x-hub-signature-256":
          input.signature ??
          `sha256=${createHmac("sha256", input.secret)
            .update(input.body)
            .digest("hex")}`,
      },
      body: input.body,
    },
  );
}

test.beforeEach(() => {
  resetControlPlane();
});

test("webhook delivery replay is deduplicated and invalid signatures cause no persisted event", async () => {
  const originalSecret = process.env.GITHUB_PATCHER_WEBHOOK_SECRET;
  const secret = "test-patcher-webhook-secret";
  process.env.GITHUB_PATCHER_WEBHOOK_SECRET = secret;
  const tenant = await seedTenant();
  const installation = await getD1()
    .prepare(
      "SELECT github_installation_id AS githubId FROM github_installations WHERE id = ?",
    )
    .bind(tenant.patcherInstallationId)
    .first<{ githubId: string }>();
  assert.ok(installation);
  const body = JSON.stringify({
    action: "suspend",
    installation: { id: Number(installation.githubId) },
  });
  try {
    const first = await handleGitHubWebhook(
      signedRequest({
        body,
        deliveryId: "delivery-replay-1",
        eventName: "installation",
        secret,
      }),
      "patcher",
    );
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), {
      accepted: true,
      duplicate: false,
    });
    const replay = await handleGitHubWebhook(
      signedRequest({
        body,
        deliveryId: "delivery-replay-1",
        eventName: "installation",
        secret,
      }),
      "patcher",
    );
    assert.deepEqual(await replay.json(), {
      accepted: true,
      duplicate: true,
    });

    const invalid = await handleGitHubWebhook(
      signedRequest({
        body,
        deliveryId: "delivery-invalid-1",
        eventName: "installation",
        secret,
        signature: `sha256=${"0".repeat(64)}`,
      }),
      "patcher",
    );
    assert.equal(invalid.status, 401);
    const persisted = await getD1()
      .prepare(
        "SELECT COUNT(*) AS count FROM github_webhook_deliveries",
      )
      .first<{ count: number }>();
    assert.equal(Number(persisted?.count), 1);
    const status = await getD1()
      .prepare("SELECT status FROM github_installations WHERE id = ?")
      .bind(tenant.patcherInstallationId)
      .first<{ status: string }>();
    assert.equal(status?.status, "suspended");
  } finally {
    if (originalSecret === undefined) {
      delete process.env.GITHUB_PATCHER_WEBHOOK_SECRET;
    } else {
      process.env.GITHUB_PATCHER_WEBHOOK_SECRET = originalSecret;
    }
  }
});

test("distinct duplicate merge events create only one verification run", async () => {
  const originalSecret = process.env.GITHUB_PATCHER_WEBHOOK_SECRET;
  const secret = "test-patcher-webhook-secret";
  process.env.GITHUB_PATCHER_WEBHOOK_SECRET = secret;
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant, {
    state: "pr_open",
    migrationState: "draft_pr_open",
  });
  const installation = await getD1()
    .prepare(
      "SELECT github_installation_id AS githubId FROM github_installations WHERE id = ?",
    )
    .bind(tenant.patcherInstallationId)
    .first<{ githubId: string }>();
  const repository = await getD1()
    .prepare(
      "SELECT github_repository_id AS githubId FROM repositories WHERE id = ?",
    )
    .bind(tenant.repositoryId)
    .first<{ githubId: string }>();
  assert.ok(installation && repository);
  const branch = `migration-autopilot/campaign/${runId}`;
  await getD1()
    .prepare("UPDATE migration_runs SET manifest = ? WHERE id = ?")
    .bind(
      JSON.stringify({
        pullRequest: { number: 42, branch },
      }),
      runId,
    )
    .run();
  const body = JSON.stringify({
    action: "closed",
    installation: { id: Number(installation.githubId) },
    repository: { id: Number(repository.githubId) },
    pull_request: {
      number: 42,
      merged: true,
      merge_commit_sha: "e".repeat(40),
      head: { ref: branch },
    },
  });
  try {
    for (const deliveryId of ["merge-semantic-1", "merge-semantic-2"]) {
      const response = await handleGitHubWebhook(
        signedRequest({
          body,
          deliveryId,
          eventName: "pull_request",
          secret,
        }),
        "patcher",
      );
      assert.equal(response.status, 202);
    }
    const merged = await getD1()
      .prepare(
        "SELECT state, verification_run_id AS verificationRunId FROM migration_runs WHERE id = ?",
      )
      .bind(runId)
      .first<{ state: string; verificationRunId: string | null }>();
    assert.equal(merged?.state, "merged");
    assert.ok(merged?.verificationRunId);
    const verificationRuns = await getD1()
      .prepare(
        "SELECT COUNT(*) AS count FROM migration_runs WHERE repository_migration_id = ? AND kind = 'verification'",
      )
      .bind(tenant.repositoryMigrationId)
      .first<{ count: number }>();
    assert.equal(Number(verificationRuns?.count), 1);
  } finally {
    if (originalSecret === undefined) {
      delete process.env.GITHUB_PATCHER_WEBHOOK_SECRET;
    } else {
      process.env.GITHUB_PATCHER_WEBHOOK_SECRET = originalSecret;
    }
  }
});
