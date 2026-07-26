import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
