import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { parseMigrationAssessment } from "../lib/migration/assessment-validation";
import { verifyGitHubWebhookSignature } from "../lib/security/webhooks";

test("GitHub webhook verification authenticates the exact raw body", () => {
  const body = '{"action":"opened"}';
  const secret = "test-webhook-secret";
  const signature = `sha256=${createHmac("sha256", secret)
    .update(body)
    .digest("hex")}`;
  assert.equal(verifyGitHubWebhookSignature(body, signature, secret), true);
  assert.equal(
    verifyGitHubWebhookSignature(`${body}\n`, signature, secret),
    false,
  );
});

test("assessment boundary validates paths and discards repository excerpts", () => {
  const parsed = parseMigrationAssessment({
    specId: "reference.stripe-node.20-to-22",
    specRevision: 1,
    status: "impact-found",
    dependency: {
      packageName: "stripe",
      declaredRange: "^20.3.0",
      resolvedVersion: "20.3.1",
      manifestPath: "package.json",
      lockfilePath: "package-lock.json",
      supportedSource: true,
      targetSatisfied: false,
      warnings: [],
    },
    findings: [
      {
        id: "finding_1",
        ruleId: "stripe.constructor.new",
        path: "src/billing.ts",
        location: { start: 0, end: 6, line: 1, column: 1 },
        excerpt: "private repository source",
        message: "Construct the client with new.",
        confidence: "certain",
        coverage: "full",
        autoPatchEligible: true,
        evidence: [
          {
            title: "Migration guide",
            url: "https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v22",
          },
        ],
      },
    ],
    scannedFiles: ["src/billing.ts"],
    skipped: [],
  });
  assert.equal(parsed.findings[0]?.excerpt, "");

  assert.throws(
    () =>
      parseMigrationAssessment({
        ...parsed,
        findings: [{ ...parsed.findings[0], path: "../outside.ts" }],
      }),
    /normalized relative repository path/,
  );
});
