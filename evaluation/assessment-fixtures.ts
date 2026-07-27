import type { MigrationSpecV1 } from "../lib/domain";
import type { RepositoryFile } from "../lib/migration/contracts";

export type AssessmentFixture = {
  id: string;
  files: RepositoryFile[];
  expected: Array<{ ruleId: string; path: string }>;
  expectedStatus?: "no-impact" | "impact-found" | "partial-coverage";
};

function change(
  input: Pick<
    MigrationSpecV1["changes"][number],
    "id" | "title" | "detectors"
  >,
): MigrationSpecV1["changes"][number] {
  return {
    ...input,
    description: `Purpose-built evaluation rule for ${input.title}.`,
    severity: "breaking",
    citations: [
      {
        artifactId: "artifact_eval",
        locator: `${input.title} migration section`,
        excerpt: `${input.title} must be reviewed during the v3 migration.`,
      },
    ],
    transformation: {
      kind: "manual",
      parameters: {},
      requiresModelConsent: false,
    },
    behavioralInvariants: ["The observable API behavior remains equivalent."],
    validationHints: ["Run typecheck and tests."],
    autoPatchEligible: false,
    knownLimitations: ["Dynamic indirection requires manual review."],
  };
}

export const evaluationSpec: MigrationSpecV1 = {
  schemaVersion: "1",
  id: "spec_eval_acme_v3",
  organizationId: "org_eval_provider",
  campaignId: "cmp_eval_acme_v3",
  revision: 1,
  status: "approved",
  providerName: "Purpose-built evaluation provider",
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
      id: "artifact_eval",
      title: "Purpose-built Acme v3 migration guide",
      kind: "markdown",
      mediaType: "text/markdown",
      sha256: "e".repeat(64),
    },
  ],
  changes: [
    change({
      id: "acme.import",
      title: "Module import",
      detectors: [
        {
          kind: "import",
          moduleName: "acme-sdk",
          configuration: { evaluation: true },
        },
      ],
    }),
    change({
      id: "acme.constructor",
      title: "Client construction",
      detectors: [
        {
          kind: "constructor",
          moduleName: "acme-sdk",
          configuration: { evaluation: true },
        },
      ],
    }),
    change({
      id: "acme.charge",
      title: "Charge call",
      detectors: [
        {
          kind: "call_expression",
          moduleName: "acme-sdk",
          member: "charge",
          callArgumentIndex: 0,
          configuration: { evaluation: true },
        },
      ],
    }),
    change({
      id: "acme.context",
      title: "Context type",
      detectors: [
        {
          kind: "symbol_reference",
          moduleName: "acme-sdk",
          symbol: "Context",
          configuration: { evaluation: true },
        },
      ],
    }),
    change({
      id: "acme.literal-fallback",
      title: "Legacy literal fallback",
      detectors: [
        {
          kind: "text_fallback",
          moduleName: "acme-sdk",
          textPattern: "legacyAcmeMode",
          configuration: { evaluation: true },
        },
      ],
    }),
  ],
  generalLimitations: ["This corpus contains no executable provider code."],
  createdAt: "2026-07-26T00:00:00.000Z",
  approvedAt: "2026-07-26T00:01:00.000Z",
  approvedByMembershipId: "mem_eval_approver",
};

const packageJson: RepositoryFile = {
  path: "package.json",
  content: JSON.stringify({
    dependencies: { "acme-sdk": "^2.4.0" },
    engines: { node: ">=20" },
  }),
};

const packageLock: RepositoryFile = {
  path: "package-lock.json",
  content: JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "acme-sdk": "^2.4.0" } },
      "node_modules/acme-sdk": { version: "2.4.1" },
    },
  }),
};

function repository(
  path: string,
  content: string,
  expected: AssessmentFixture["expected"],
  extra: RepositoryFile[] = [],
): Omit<AssessmentFixture, "id"> {
  return {
    files: [packageJson, packageLock, ...extra, { path, content }],
    expected,
  };
}

export const assessmentFixtures: AssessmentFixture[] = [
  {
    id: "esm-default-constructor-call",
    ...repository("src/a.ts", 'import Client from "acme-sdk";\nClient();', [
      { ruleId: "acme.import", path: "src/a.ts" },
      { ruleId: "acme.constructor", path: "src/a.ts" },
    ]),
  },
  {
    id: "esm-default-new",
    ...repository("src/b.ts", 'import SDK from "acme-sdk";\nnew SDK();', [
      { ruleId: "acme.import", path: "src/b.ts" },
      { ruleId: "acme.constructor", path: "src/b.ts" },
    ]),
  },
  {
    id: "esm-namespace-member-call",
    ...repository("src/c.ts", 'import * as SDK from "acme-sdk";\nSDK.charge(10);', [
      { ruleId: "acme.import", path: "src/c.ts" },
      { ruleId: "acme.charge", path: "src/c.ts" },
    ]),
  },
  {
    id: "esm-named-alias-member-call",
    ...repository(
      "src/d.ts",
      'import { Client as Billing } from "acme-sdk";\nBilling.charge(10);',
      [
        { ruleId: "acme.import", path: "src/d.ts" },
        { ruleId: "acme.charge", path: "src/d.ts" },
      ],
    ),
  },
  {
    id: "commonjs-direct",
    ...repository("src/e.cjs", 'const SDK = require("acme-sdk");\nSDK.charge(10);', [
      { ruleId: "acme.import", path: "src/e.cjs" },
      { ruleId: "acme.charge", path: "src/e.cjs" },
    ]),
  },
  {
    id: "commonjs-property",
    ...repository(
      "src/f.cjs",
      'const Client = require("acme-sdk").Client;\nClient();',
      [
        { ruleId: "acme.import", path: "src/f.cjs" },
        { ruleId: "acme.constructor", path: "src/f.cjs" },
      ],
    ),
  },
  {
    id: "commonjs-destructure",
    ...repository(
      "src/g.cjs",
      'const { Client } = require("acme-sdk");\nClient.charge(10);',
      [
        { ruleId: "acme.import", path: "src/g.cjs" },
        { ruleId: "acme.charge", path: "src/g.cjs" },
      ],
    ),
  },
  {
    id: "typescript-import-equals",
    ...repository(
      "src/h.ts",
      'import SDK = require("acme-sdk");\nSDK.charge(10);',
      [
        { ruleId: "acme.import", path: "src/h.ts" },
        { ruleId: "acme.charge", path: "src/h.ts" },
      ],
    ),
  },
  {
    id: "typescript-type-reference",
    ...repository(
      "src/i.ts",
      'import type { Context } from "acme-sdk";\nexport function run(value: Context): Context { return value; }',
      [
        { ruleId: "acme.import", path: "src/i.ts" },
        { ruleId: "acme.context", path: "src/i.ts" },
      ],
    ),
  },
  {
    id: "reexport-named",
    ...repository(
      "src/j.ts",
      'export { Client as BillingClient } from "acme-sdk";',
      [{ ruleId: "acme.import", path: "src/j.ts" }],
    ),
  },
  {
    id: "reexport-star",
    ...repository("src/k.ts", 'export * from "acme-sdk";', [
      { ruleId: "acme.import", path: "src/k.ts" },
    ]),
  },
  {
    id: "local-alias",
    ...repository(
      "src/l.ts",
      'import SDK from "acme-sdk";\nconst Billing = SDK;\nBilling.charge(10);',
      [
        { ruleId: "acme.import", path: "src/l.ts" },
        { ruleId: "acme.charge", path: "src/l.ts" },
      ],
    ),
  },
  {
    id: "jsx-member-call",
    ...repository(
      "src/m.tsx",
      'import SDK from "acme-sdk";\nexport const App = () => <button onClick={() => SDK.charge(10)}>Pay</button>;',
      [
        { ruleId: "acme.import", path: "src/m.tsx" },
        { ruleId: "acme.charge", path: "src/m.tsx" },
      ],
    ),
  },
  {
    id: "javascript-esm",
    ...repository("src/n.mjs", 'import SDK from "acme-sdk";\nSDK.charge(10);', [
      { ruleId: "acme.import", path: "src/n.mjs" },
      { ruleId: "acme.charge", path: "src/n.mjs" },
    ]),
  },
  {
    id: "literal-fallback",
    ...repository("src/o.ts", 'export const mode = "legacyAcmeMode";', [
      { ruleId: "acme.literal-fallback", path: "src/o.ts" },
    ]),
    expectedStatus: "partial-coverage",
  },
  {
    id: "dynamic-import-partial",
    ...repository(
      "src/p.ts",
      'const packageName = "acme-sdk";\nexport const sdk = await import(packageName);',
      [],
    ),
    expectedStatus: "partial-coverage",
  },
  {
    id: "no-impact-unrelated-package",
    ...repository("src/q.ts", 'import thing from "other-sdk";\nthing();', []),
    expectedStatus: "no-impact",
  },
  {
    id: "no-impact-comment-only",
    ...repository("src/r.ts", '// import SDK from "acme-sdk";\nexport const ok = true;', []),
    expectedStatus: "no-impact",
  },
  {
    id: "no-impact-string-only",
    ...repository("src/s.ts", 'export const packageName = "acme-sdk";', []),
    expectedStatus: "no-impact",
  },
  {
    id: "call-without-required-argument",
    ...repository("src/t.ts", 'import SDK from "acme-sdk";\nSDK.charge();', [
      { ruleId: "acme.import", path: "src/t.ts" },
    ]),
  },
  {
    id: "computed-literal-member",
    ...repository("src/u.ts", 'import SDK from "acme-sdk";\nSDK["charge"](10);', [
      { ruleId: "acme.import", path: "src/u.ts" },
      { ruleId: "acme.charge", path: "src/u.ts" },
    ]),
  },
  {
    id: "workspace-npm",
    ...repository(
      "packages/app/src/v.ts",
      'import SDK from "acme-sdk";\nSDK.charge(10);',
      [
        { ruleId: "acme.import", path: "packages/app/src/v.ts" },
        { ruleId: "acme.charge", path: "packages/app/src/v.ts" },
      ],
      [
        {
          path: "packages/app/package.json",
          content: JSON.stringify({
            dependencies: { "acme-sdk": "^2.4.0" },
            engines: { node: ">=20" },
          }),
        },
      ],
    ),
  },
  {
    id: "workspace-pnpm",
    ...repository(
      "packages/worker/src/w.ts",
      'import SDK from "acme-sdk";\nnew SDK();',
      [
        { ruleId: "acme.import", path: "packages/worker/src/w.ts" },
        { ruleId: "acme.constructor", path: "packages/worker/src/w.ts" },
      ],
      [
        {
          path: "pnpm-workspace.yaml",
          content: "packages:\n  - packages/*\n",
        },
      ],
    ),
  },
  {
    id: "multiple-files",
    files: [
      packageJson,
      packageLock,
      {
        path: "src/x.ts",
        content: 'import SDK from "acme-sdk";\nSDK.charge(10);',
      },
      {
        path: "src/y.ts",
        content: 'import { Context } from "acme-sdk";\nexport type C = Context;',
      },
    ],
    expected: [
      { ruleId: "acme.import", path: "src/x.ts" },
      { ruleId: "acme.charge", path: "src/x.ts" },
      { ruleId: "acme.import", path: "src/y.ts" },
      { ruleId: "acme.context", path: "src/y.ts" },
    ],
  },
];
