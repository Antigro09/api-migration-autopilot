import assert from "node:assert/strict";
import test from "node:test";
import { parseMigrationSpecV1 } from "../lib/domain";
import { assessStripeV20ToV22 } from "../lib/migration/analyzer";
import type { RepositoryFile } from "../lib/migration/contracts";
import {
  normalizeRepositoryPath,
  validatePatchEnvelope,
  validateProposedPatch,
} from "../lib/migration/patch-security";
import {
  createDeterministicStripePatch,
  createParameterizedTemplatePatch,
} from "../lib/migration/transformer";

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
  assert.throws(
    () => normalizeRepositoryPath("%2e%2e%2fsecrets.txt"),
    /Encoded separators/,
  );
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

test("patch envelope independently refuses binary, duplicate, oversized, excessive, and stale-base edits", async () => {
  const edit = {
    path: "src/client.ts",
    originalContent: "oldClient();\n",
    newContent: `new Client();\0${"x".repeat(128)}`,
    ruleIds: ["provider.constructor"],
    rationale: ["Use the supported constructor."],
  };
  const result = await validatePatchEnvelope({
    baseSha: "a".repeat(40),
    expectedBaseSha: "b".repeat(40),
    files: [edit, edit],
    allowedPaths: [edit.path],
    maxFiles: 1,
    maxPatchBytes: 32,
  });
  assert.equal(result.valid, false);
  const codes = new Set(result.issues.map((issue) => issue.code));
  for (const code of [
    "base-sha-mismatch",
    "too-many-files",
    "binary-content",
    "duplicate-path",
    "patch-too-large",
  ] as const) {
    assert.ok(codes.has(code), `expected ${code}`);
  }
});

test("provider templates apply only to the exact detected candidate range", async () => {
  const source = "const client = oldClient(key);\nconst untouched = oldClient(key);\n";
  const before = "oldClient(key)";
  const start = source.indexOf(before);
  const spec = parseMigrationSpecV1({
    schemaVersion: "1",
    id: "spec_template",
    organizationId: "org_template",
    campaignId: "cmp_template",
    revision: 1,
    status: "draft",
    providerName: "Provider",
    productName: "Provider SDK",
    package: {
      ecosystem: "npm",
      name: "@provider/sdk",
      language: "typescript",
      sourceRange: ">=1 <2",
      targetVersion: "2.0.0",
    },
    sourceArtifacts: [
      {
        id: "artifact_template",
        title: "Migration guide",
        kind: "markdown",
        mediaType: "text/markdown",
        sha256: "1".repeat(64),
      },
    ],
    changes: [
      {
        id: "SDK-TEMPLATE",
        title: "Construct the new client",
        description: "Use the v2 constructor.",
        severity: "breaking",
        citations: [
          {
            artifactId: "artifact_template",
            locator: "Constructor",
            excerpt: "Replace oldClient with new Client.",
          },
        ],
        detectors: [
          {
            kind: "call_expression",
            moduleName: "@provider/sdk",
            symbol: "oldClient",
            configuration: {},
          },
        ],
        transformation: {
          kind: "parameterized_template",
          recipeId: "literal-text-replacement-v1",
          parameters: {
            before,
            after: "new Client(key)",
          },
          requiresModelConsent: false,
        },
        behavioralInvariants: ["The credential is unchanged."],
        validationHints: ["Run typecheck."],
        autoPatchEligible: true,
        knownLimitations: ["Wrappers require review."],
      },
    ],
    generalLimitations: ["Dynamic calls are partial coverage."],
    createdAt: new Date().toISOString(),
  });
  const patch = await createParameterizedTemplatePatch({
    baseSha: "a".repeat(40),
    files: [{ path: "src/client.ts", content: source }],
    findings: [
      {
        id: "finding_template",
        ruleId: "SDK-TEMPLATE",
        path: "src/client.ts",
        location: {
          start,
          end: start + before.length,
          line: 1,
          column: start + 1,
        },
        excerpt: "",
        message: "Detected the legacy constructor.",
        confidence: "certain",
        coverage: "full",
        autoPatchEligible: true,
        evidence: [],
      },
    ],
    spec,
  });
  assert.equal(patch.files.length, 1);
  assert.equal(patch.patchedFindingIds[0], "finding_template");
  assert.equal(
    patch.files[0]?.newContent,
    "const client = new Client(key);\nconst untouched = oldClient(key);\n",
  );
});
