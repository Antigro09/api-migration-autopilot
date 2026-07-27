import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { parseMigrationAssessment } from "../lib/migration/assessment-validation";
import { applySecurityHeaders } from "../lib/security/headers";
import {
  assertSameOrigin,
  CrossSiteRequestError,
} from "../lib/security/requests";
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

test("dynamic responses are private and carry the browser security boundary", () => {
  const headers = new Headers();
  applySecurityHeaders(headers, "https://autopilot.test/customer");
  assert.equal(headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.equal(headers.get("strict-transport-security"), "max-age=31536000");
  assert.match(headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(headers.get("content-security-policy") ?? "", /worker-src 'self' blob:/);
  assert.doesNotMatch(headers.get("permissions-policy") ?? "", /camera=\*/);
});

test("same-origin commands accept exact origins and a constrained opaque navigation", () => {
  assert.doesNotThrow(() =>
    assertSameOrigin(
      new Request("https://autopilot.test/api/command", {
        method: "POST",
        headers: { origin: "https://autopilot.test" },
      }),
    ),
  );

  assert.doesNotThrow(() =>
    assertSameOrigin(
      new Request("https://autopilot.test/api/command", {
        method: "POST",
        headers: {
          origin: "null",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
          "sec-fetch-user": "?1",
        },
      }),
    ),
  );
});

test("opaque command origins fail unless every browser navigation proof is present", () => {
  const rejectedHeaders: Array<Record<string, string>> = [
    {},
    { origin: "https://attacker.example" },
    {
      origin: "null",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-user": "?1",
    },
    {
      origin: "null",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "sec-fetch-user": "?1",
    },
    {
      origin: "null",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "iframe",
      "sec-fetch-user": "?1",
    },
    {
      origin: "null",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
  ];
  for (const headers of rejectedHeaders) {
    assert.throws(
      () =>
        assertSameOrigin(
          new Request("https://autopilot.test/api/command", {
            method: "POST",
            headers,
          }),
        ),
      CrossSiteRequestError,
    );
  }
});

function routeFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? routeFiles(path)
      : entry.name === "route.ts"
        ? [path]
        : [];
  });
}

test("every shipped API route declares the correct browser, workflow, or webhook trust boundary", () => {
  const root = join(process.cwd(), "app", "api");
  for (const path of routeFiles(root)) {
    const source = readFileSync(path, "utf8");
    const route = relative(root, path).replaceAll("\\", "/");
    const hasPost = /export async function POST/.test(source);
    const hasGet = /export async function GET/.test(source);
    if (route.startsWith("webhooks/github/")) {
      assert.match(source, /handleGitHubWebhook/, `${route}: webhook verifier`);
      continue;
    }
    if (route.startsWith("internal/")) {
      assert.match(
        source,
        /assertWorkflowAuthorization\(request\)/,
        `${route}: signed workflow authorization`,
      );
      continue;
    }
    if (hasPost) {
      assert.match(
        source,
        /assertSameOrigin\(request\)/,
        `${route}: same-origin mutation check`,
      );
      assert.match(
        source,
        /requireAuthenticatedActor/,
        `${route}: authenticated actor`,
      );
    }
    if (hasGet && route !== "health/route.ts") {
      assert.match(
        source,
        /requireAuthenticatedActor/,
        `${route}: authenticated read`,
      );
    }
  }
});
