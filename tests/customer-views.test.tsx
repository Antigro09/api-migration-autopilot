import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomerView } from "../app/components/customer-views";
import type { PatchReviewData } from "../lib/data/customer";
import { MODEL_CONSENT_DISCLOSURE } from "../lib/domain";
import { integrationReadiness } from "../lib/platform/config";

const PATCH_HASH = "b".repeat(64);

function review(overrides?: Partial<PatchReviewData>): PatchReviewData {
  return {
    migrationId: "rmg_1",
    repositoryOwner: "customer-org",
    repositoryName: "billing-service",
    campaignName: "Stripe 20 to 22",
    providerName: "Independent Stripe reference",
    runId: "run_1",
    runState: "awaiting_review",
    migrationState: "ready_for_review",
    baseSha: "a".repeat(40),
    patchSha256: PATCH_HASH,
    approvedPatchSha256: null,
    approvedAt: null,
    integrityValid: true,
    integrityIssues: [],
    files: [
      {
        path: "src/billing.ts",
        additions: 1,
        deletions: 1,
        ruleIds: ["stripe.constructor.new"],
        rationale: ["Instantiate the v22 ES class export with new."],
      },
    ],
    selectedPath: "src/billing.ts",
    selectedDiff: {
      path: "src/billing.ts",
      additions: 1,
      deletions: 1,
      truncated: false,
      hunks: [
        {
          originalStart: 1,
          originalCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [
            {
              kind: "removed",
              originalLine: 1,
              newLine: null,
              text: "const stripe = Stripe(key);",
            },
            {
              kind: "added",
              originalLine: null,
              newLine: 1,
              text: "const stripe = new Stripe(key);",
            },
          ],
        },
      ],
    },
    additions: 1,
    deletions: 1,
    unresolvedFindingCount: 2,
    validation: [
      {
        category: "test",
        command: "npm run test",
        outcome: "passed",
        exitCode: 0,
        durationMs: 1_200,
        summary: "test passed",
        logAvailable: true,
      },
    ],
    pullRequest: null,
    modelConsentGranted: false,
    modelConsentPolicyVersion: MODEL_CONSENT_DISCLOSURE.version,
    publishable: true,
    warnRequired: false,
    ...overrides,
  };
}

function render(
  view: "patch" | "policies",
  patchReview: PatchReviewData | null,
): string {
  return renderToStaticMarkup(
    <CustomerView
      view={view}
      patchReview={patchReview}
      consentDisclosure={MODEL_CONSENT_DISCLOSURE}
      workspaceId="org_1"
      integrations={integrationReadiness()}
    />,
  );
}

test("patch review renders the real diff, exact hash, and approval intent", () => {
  const markup = render("patch", review());
  assert.match(markup, /const stripe = new Stripe\(key\);/);
  assert.match(markup, /diff-line-added/);
  assert.match(markup, /diff-line-removed/);
  assert.match(markup, new RegExp(PATCH_HASH));
  assert.match(markup, /name="approvalIntent" value="open-draft-pr"/);
  assert.match(markup, /Approve exact hash/);
  assert.match(markup, /Unresolved findings 2/);
  // Publication stays disabled until the exact hash is approved.
  assert.match(markup, /Open draft pull request/);
  assert.match(markup, /button-disabled[^>]*>Open draft pull request/);
});

test("an integrity failure disables approval and says publication is impossible", () => {
  const markup = render(
    "patch",
    review({
      integrityValid: false,
      publishable: false,
      integrityIssues: [
        {
          code: "path-not-allowed",
          path: "src/other.ts",
          message: "The run was not authorized to change this path.",
          source: "control-plane",
        },
      ],
    }),
  );
  assert.match(markup, /This patch cannot be published/);
  assert.match(markup, /path-not-allowed/);
  assert.match(markup, /button-disabled[^>]*>Approve exact hash/);
});

test("failed validation still allows approval but announces the warning", () => {
  const markup = render(
    "patch",
    review({
      runState: "validation_failed",
      warnRequired: true,
      validation: [
        {
          category: "test",
          command: "npm run test",
          outcome: "failed",
          exitCode: 1,
          durationMs: 900,
          summary: "2 failing",
          logAvailable: true,
        },
      ],
    }),
  );
  assert.match(markup, /Declared validation commands failed/);
  assert.match(markup, /prominent warning/);
  assert.match(markup, /button-primary[^>]*>Approve exact hash/);
});

test("patch review without a generated patch fails closed to the request form", () => {
  const markup = render("patch", null);
  assert.match(markup, /No generated patch/);
  assert.match(markup, /Request patch/);
  assert.doesNotMatch(markup, /Approve exact hash/);
});

test("the consent disclosure names the vendor, categories, and retention limits", () => {
  const markup = render("policies", review());
  assert.match(markup, new RegExp(MODEL_CONSENT_DISCLOSURE.version));
  assert.match(markup, /OpenAI/);
  assert.match(markup, /Minimized candidate snippets/);
  assert.match(markup, /What is never sent/);
  assert.match(markup, /Zero Data Retention/);
  assert.match(markup, /Grant model processing consent/);
  assert.match(markup, /name="decision" value="grant"/);
});

test("a granted consent renders the revoke command instead", () => {
  const markup = render("policies", review({ modelConsentGranted: true }));
  assert.match(markup, /Revoke model processing consent/);
  assert.match(markup, /name="decision" value="revoke"/);
});
