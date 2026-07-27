import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import test from "node:test";

const buildRoot = new URL("../dist/", import.meta.url);

test("production bundle contains the invite-only product and live assessment route", async () => {
  const server = await readFile(new URL("server/index.js", buildRoot), "utf8");
  assert.match(server, /API Migration Autopilot/);
  assert.match(server, /Sign in to access an organization workspace/);
  assert.match(server, /route:\/api\/assessments/);
  assert.match(server, /route:\/api\/internal\/runs\/:id\/assessment-result/);
  assert.match(server, /route:\/api\/webhooks\/github\/scanner/);
  assert.doesNotMatch(server, /demo persona|mock funnel|seeded results/i);
});

test("production bundle declares persistent storage and redacted health readiness", async () => {
  const [server, wrangler] = await Promise.all([
    readFile(new URL("server/index.js", buildRoot), "utf8"),
    readFile(new URL("server/wrangler.json", buildRoot), "utf8"),
  ]);
  assert.match(server, /service:\s*"api-migration-autopilot"/);
  assert.match(server, /configuredIntegrations/);
  assert.doesNotMatch(server, /sk_test_[A-Za-z0-9]{16,}/);
  assert.match(wrangler, /"binding":\s*"DB"/);
  assert.match(wrangler, /"binding":\s*"ARTIFACTS"/);
});

test("production bundle exposes the full patch lifecycle as signed or authenticated routes", async () => {
  const server = await readFile(new URL("server/index.js", buildRoot), "utf8");
  for (const route of [
    "/api/consents",
    "/api/patches",
    "/api/patches/:runId/files",
    "/api/patches/approve",
    "/api/patches/publish",
    "/api/operations/alerts",
    "/api/operations/audit/verify",
    "/api/operations/deletions/retry",
    "/api/operations/runs/retry",
    "/api/operations/support/requests",
    "/api/operations/support/artifacts/:artifactId",
    "/api/support/requests/resolve",
    "/api/support/grants/revoke",
    "/api/runs/:id",
    "/api/internal/runs/:id/patch-packet",
    "/api/internal/runs/:id/patch-result",
    "/api/internal/runs/:id/model-consent",
    "/api/internal/retention/sweep",
  ]) {
    assert.match(
      server,
      new RegExp(`route:${route.replaceAll("/", "\\/")}(?:"|')`),
      `expected the production bundle to register ${route}`,
    );
  }
});

test("production bundle keeps the publication and consent invariants in shipped copy", async () => {
  const server = await readFile(new URL("server/index.js", buildRoot), "utf8");
  // The exact-hash approval intent and its refusal path must survive bundling.
  assert.match(server, /open-draft-pr/);
  assert.match(server, /external-model-processing\/\d{4}-\d{2}-\d{2}/);
  assert.match(server, /Approve exact hash/);
  assert.match(server, /never merged\s*\n?\s*automatically|never merged/i);
  // No auto-merge affordance may be shipped.
  assert.doesNotMatch(server, /"PUT",\s*path:\s*`?[^`"]*\/pulls\/[^`"]*\/merge/);
});

test("production responses ship private-cache and browser security boundaries", async () => {
  const server = await readFile(new URL("server/index.js", buildRoot), "utf8");
  for (const invariant of [
    "private, no-store, max-age=0",
    "frame-ancestors 'none'",
    "X-Content-Type-Options",
    "Strict-Transport-Security",
    "Permissions-Policy",
    "RATE_LIMITED",
  ]) {
    assert.match(server, new RegExp(invariant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Monaco is self-hosted and remains outside the initial client payload", async () => {
  const assetsRoot = new URL("client/assets/", buildRoot);
  const names = await readdir(assetsRoot);
  const lazyName = names.find((name) => name.startsWith("lazy-patch-diff-"));
  const editorName = names.find((name) => name.startsWith("editor.api-"));
  const entryName = names.find((name) => name.startsWith("index-") && name.endsWith(".js"));
  assert.ok(lazyName, "expected the patch review client chunk");
  assert.ok(editorName, "expected a self-hosted Monaco editor chunk");
  assert.ok(entryName, "expected the initial client entry chunk");

  const [lazy, entry, lazyStats, editorStats] = await Promise.all([
    readFile(new URL(lazyName, assetsRoot), "utf8"),
    readFile(new URL(entryName, assetsRoot), "utf8"),
    stat(new URL(lazyName, assetsRoot)),
    stat(new URL(editorName, assetsRoot)),
  ]);
  assert.match(lazy, /import\(`\.\/editor\.api-/);
  assert.doesNotMatch(entry, /editor\.api-/);
  assert.ok(lazyStats.size < 50_000, "patch selector must stay lightweight");
  assert.ok(editorStats.size < 3_000_000, "lazy editor chunk exceeded its budget");
  assert.doesNotMatch(lazy, /cdn\.jsdelivr|unpkg\.com|cdnjs\.cloudflare/);
});
