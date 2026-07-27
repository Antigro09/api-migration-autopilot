import assert from "node:assert/strict";
import test from "node:test";
import type { MigrationSpecV1 } from "../lib/domain";
import { assessMigrationSpec } from "../lib/migration/generic-analyzer";
import { resolvePackageDependency } from "../lib/migration/dependencies";
import type { RepositoryFile } from "../lib/migration/contracts";

function spec(
  changes: MigrationSpecV1["changes"] = [
    {
      id: "acme.import",
      title: "Acme import",
      description: "Review imports from the previous SDK entry point.",
      severity: "breaking",
      citations: [
        {
          artifactId: "artifact_1",
          locator: "Migration guide, imports",
          excerpt: "Import the v3 client from the package entry point.",
        },
      ],
      detectors: [
        {
          kind: "import",
          moduleName: "acme-sdk",
          configuration: { authoringMode: "test" },
        },
      ],
      transformation: {
        kind: "manual",
        parameters: {},
        requiresModelConsent: false,
      },
      behavioralInvariants: ["Requests keep the same idempotency behavior."],
      validationHints: ["Run the declared typecheck command."],
      autoPatchEligible: false,
      knownLimitations: ["Dynamic imports require manual review."],
    },
    {
      id: "acme.charge-call",
      title: "Charge call",
      description: "Review calls to the renamed charge method.",
      severity: "breaking",
      citations: [
        {
          artifactId: "artifact_1",
          locator: "Migration guide, charge calls",
          excerpt: "The charge call has a new options object.",
        },
      ],
      detectors: [
        {
          kind: "call_expression",
          moduleName: "acme-sdk",
          member: "charge",
          callArgumentIndex: 0,
          configuration: { authoringMode: "test" },
        },
      ],
      transformation: {
        kind: "parameterized_template",
        recipeId: "literal-text-replacement-v1",
        parameters: { before: "charge(value)", after: "charge({ value })" },
        requiresModelConsent: false,
      },
      behavioralInvariants: ["The charged amount is unchanged."],
      validationHints: ["Run unit tests."],
      autoPatchEligible: true,
      knownLimitations: ["Computed member access requires review."],
    },
  ],
): MigrationSpecV1 {
  return {
    schemaVersion: "1",
    id: "spec_acme_v3",
    organizationId: "org_provider",
    campaignId: "cmp_acme_v3",
    revision: 2,
    status: "approved",
    providerName: "Acme",
    productName: "Acme SDK",
    package: {
      ecosystem: "npm",
      name: "acme-sdk",
      language: "typescript",
      sourceRange: ">=2.0.0 <3.0.0",
      targetVersion: "3.0.0",
    },
    sourceArtifacts: [
      {
        id: "artifact_1",
        title: "Acme v3 migration guide",
        kind: "markdown",
        mediaType: "text/markdown",
        sha256: "a".repeat(64),
      },
    ],
    changes,
    generalLimitations: ["Generated wrappers require manual review."],
    createdAt: "2026-07-26T12:00:00.000Z",
    approvedAt: "2026-07-26T12:05:00.000Z",
    approvedByMembershipId: "mem_provider_approver",
  };
}

const manifest: RepositoryFile = {
  path: "package.json",
  content: JSON.stringify({
    dependencies: { "acme-sdk": "^2.4.0" },
    engines: { node: ">=20" },
  }),
};

test("spec-driven analysis follows ESM aliases and member calls without executing source", () => {
  const files: RepositoryFile[] = [
    manifest,
    {
      path: "package-lock.json",
      content: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { "acme-sdk": "^2.4.0" } },
          "node_modules/acme-sdk": { version: "2.4.1" },
        },
      }),
    },
    {
      path: "src/payments.ts",
      content:
        'import Client from "acme-sdk";\nthrow new Error("must never execute");\nconst api = Client;\napi.charge(500);',
    },
  ];
  const assessment = assessMigrationSpec({ files, spec: spec() });
  assert.equal(assessment.specId, "spec_acme_v3");
  assert.equal(assessment.dependency.resolvedVersion, "2.4.1");
  assert.equal(assessment.dependency.supportedSource, true);
  assert.ok(
    assessment.findings.some((finding) => finding.ruleId === "acme.import"),
  );
  assert.ok(
    assessment.findings.some(
      (finding) =>
        finding.ruleId === "acme.charge-call" &&
        finding.path === "src/payments.ts",
    ),
  );
  assert.ok(
    assessment.findings.every(
      (finding) =>
        finding.evidence[0]?.title.includes("Migration guide") &&
        finding.evidence[0]?.url === undefined,
    ),
  );
});

test("dependency resolution covers npm, pnpm, Yarn classic, and Yarn Berry lockfiles", () => {
  const variants: Array<{ path: string; content: string }> = [
    {
      path: "package-lock.json",
      content: JSON.stringify({
        packages: { "node_modules/acme-sdk": { version: "2.5.0" } },
      }),
    },
    {
      path: "pnpm-lock.yaml",
      content: [
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    dependencies:",
        "      acme-sdk:",
        "        specifier: ^2.0.0",
        "        version: 2.5.0",
      ].join("\n"),
    },
    {
      path: "yarn.lock",
      content: '"acme-sdk@^2.0.0":\n  version "2.5.0"\n  resolved "https://registry.yarnpkg.com/acme-sdk/-/acme-sdk-2.5.0.tgz"\n',
    },
    {
      path: "packages/app/yarn.lock",
      content: 'acme-sdk@npm:^2.0.0:\n  version: 2.5.0\n  resolution: "acme-sdk@npm:2.5.0"\n',
    },
  ];
  for (const lockfile of variants) {
    const resolution = resolvePackageDependency({
      files: [manifest, lockfile],
      packageName: "acme-sdk",
      sourceRange: ">=2 <3",
      targetVersion: "3.0.0",
    });
    assert.equal(
      resolution.resolvedVersion,
      "2.5.0",
      `failed to resolve ${lockfile.path}`,
    );
  }
});

test("workspace divergence and dynamic resolution are reported as partial coverage", () => {
  const assessment = assessMigrationSpec({
    spec: spec(),
    files: [
      manifest,
      {
        path: "packages/worker/package.json",
        content: JSON.stringify({
          dependencies: { "acme-sdk": "^2.8.0" },
          engines: { node: ">=20" },
        }),
      },
      {
        path: "pnpm-lock.yaml",
        content: [
          "lockfileVersion: '9.0'",
          "importers:",
          "  .:",
          "    dependencies:",
          "      acme-sdk:",
          "        version: 2.4.0",
          "  packages/worker:",
          "    dependencies:",
          "      acme-sdk:",
          "        version: 2.8.0",
        ].join("\n"),
      },
      {
        path: "src/dynamic.ts",
        content:
          'const moduleName = "acme-sdk";\nconst sdk = await import(moduleName);',
      },
    ],
  });
  assert.equal(assessment.status, "partial-coverage");
  assert.ok(
    assessment.dependency.warnings.some((warning) =>
      warning.includes("multiple ranges"),
    ),
  );
  assert.ok(
    assessment.skipped.some((entry) =>
      entry.reason.includes("Dynamic module resolution"),
    ),
  );
});

test("CommonJS, TypeScript import-equals, named imports, and re-exports are indexed", () => {
  const files: RepositoryFile[] = [
    manifest,
    {
      path: "src/cjs.cjs",
      content: 'const SDK = require("acme-sdk");\nSDK.charge(10);',
    },
    {
      path: "src/import-equals.ts",
      content: 'import SDK = require("acme-sdk");\nSDK.charge(20);',
    },
    {
      path: "src/named.ts",
      content: 'import { Client as Billing } from "acme-sdk";\nBilling.charge(30);',
    },
    {
      path: "src/reexport.ts",
      content: 'export { Client as BillingClient } from "acme-sdk";',
    },
  ];
  const assessment = assessMigrationSpec({ files, spec: spec() });
  const importFiles = new Set(
    assessment.findings
      .filter((finding) => finding.ruleId === "acme.import")
      .map((finding) => finding.path),
  );
  assert.deepEqual(importFiles, new Set(files.slice(1).map((file) => file.path)));
  assert.equal(
    assessment.findings.filter(
      (finding) => finding.ruleId === "acme.charge-call",
    ).length,
    3,
  );
});
