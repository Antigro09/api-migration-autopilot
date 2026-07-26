import assert from "node:assert/strict";
import test from "node:test";
import { assessStripeV20ToV22 } from "../lib/migration/analyzer";
import type { RepositoryFile } from "../lib/migration/contracts";
import {
  normalizeRepositoryPath,
  validateProposedPatch,
} from "../lib/migration/patch-security";
import { createDeterministicStripePatch } from "../lib/migration/transformer";

const files: RepositoryFile[] = [
  {
    path: "package.json",
    content: JSON.stringify({
      engines: { node: ">=20" },
      dependencies: { stripe: "^20.3.0" },
    }),
  },
  {
    path: "package-lock.json",
    content: JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/stripe": { version: "20.3.1" },
      },
    }),
  },
  {
    path: "src/billing.ts",
    content: [
      'const Stripe = require("stripe").default;',
      'const stripe = Stripe("sk_test_placeholder");',
      "type RequestContext = Stripe.StripeContext;",
    ].join("\n"),
  },
];

test("Stripe reference analyzer resolves the lockfile and produces real codemod edits", async () => {
  const assessment = assessStripeV20ToV22(files);
  assert.equal(assessment.dependency.resolvedVersion, "20.3.1");
  assert.equal(assessment.dependency.supportedSource, true);
  assert.ok(
    assessment.findings.some(
      (finding) => finding.ruleId === "stripe.import.cjs-entrypoint",
    ),
  );
  assert.ok(
    assessment.findings.some(
      (finding) => finding.ruleId === "stripe.constructor.new",
    ),
  );

  const patch = await createDeterministicStripePatch({
    baseSha: "a".repeat(40),
    files,
    assessment,
  });
  assert.equal(patch.files.length, 1);
  assert.match(
    patch.files[0]?.newContent ?? "",
    /const Stripe = require\("stripe"\);/,
  );
  assert.match(
    patch.files[0]?.newContent ?? "",
    /const stripe = new Stripe\("sk_test_placeholder"\);/,
  );
  assert.match(patch.patchSha256, /^[a-f0-9]{64}$/);
});

test("patch validation blocks traversal and workflow changes", async () => {
  assert.throws(() => normalizeRepositoryPath("../secrets.txt"), /traversal/);
  const result = await validateProposedPatch({
    baseSha: "a".repeat(40),
    expectedBaseSha: "a".repeat(40),
    files: [
      {
        path: ".github/workflows/release.yml",
        originalContent: "name: release\n",
        newContent: "name: compromised\n",
        ruleIds: ["test"],
        rationale: ["test"],
      },
    ],
    allowedPaths: [".github/workflows/release.yml"],
    currentFiles: new Map([
      [".github/workflows/release.yml", "name: release\n"],
    ]),
  });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "workflow-file"));
});
