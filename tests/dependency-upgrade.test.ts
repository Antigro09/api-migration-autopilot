import assert from "node:assert/strict";
import test from "node:test";
import {
  createDependencyManifestEdit,
  overlayRepositoryFiles,
} from "../lib/migration/dependency-upgrade";
import type {
  DependencyResolution,
  RepositoryFile,
} from "../lib/migration/contracts";

const dependency: DependencyResolution = {
  packageName: "stripe",
  declaredRange: "^20.3.0",
  resolvedVersion: "20.3.1",
  manifestPath: "package.json",
  lockfilePath: "package-lock.json",
  supportedSource: true,
  targetSatisfied: false,
  warnings: [],
};

test("dependency manifest upgrade preserves JSONC comments and formatting", () => {
  const content = [
    "{",
    "  // Runtime dependencies stay grouped here.",
    '  "dependencies": {',
    '    "stripe": "^20.3.0"',
    "  },",
    '  "engines": { "node": ">=20" }',
    "}",
    "",
  ].join("\n");
  const edit = createDependencyManifestEdit({
    files: [{ path: "package.json", content }],
    dependency,
    targetVersion: "22.1.0",
  });
  assert.equal(edit.path, "package.json");
  assert.match(edit.newContent, /Runtime dependencies stay grouped here/);
  assert.match(edit.newContent, /"stripe": "22\.1\.0"/);
  assert.equal(edit.ruleIds[0], "dependency.version.target");
});

test("dependency manifest upgrade preserves the original dependency section", () => {
  const content = JSON.stringify(
    {
      devDependencies: { stripe: "~20.3.0" },
      engines: { node: ">=20" },
    },
    null,
    2,
  );
  const edit = createDependencyManifestEdit({
    files: [{ path: "packages/app/package.json", content }],
    dependency: {
      ...dependency,
      manifestPath: "packages/app/package.json",
      lockfilePath: "pnpm-lock.yaml",
    },
    targetVersion: "22.1.0",
  });
  const parsed = JSON.parse(edit.newContent) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(parsed.devDependencies?.stripe, "22.1.0");
  assert.equal(parsed.dependencies, undefined);
});

test("dependency manifest upgrade refuses ambiguity and non-exact targets", () => {
  const ambiguous = JSON.stringify({
    dependencies: { stripe: "^20.3.0" },
    devDependencies: { stripe: "^20.3.0" },
  });
  assert.throws(
    () =>
      createDependencyManifestEdit({
        files: [{ path: "package.json", content: ambiguous }],
        dependency,
        targetVersion: "22.1.0",
      }),
    /more than one dependency section/,
  );
  assert.throws(
    () =>
      createDependencyManifestEdit({
        files: [
          {
            path: "package.json",
            content: '{"dependencies":{"stripe":"^20.3.0"}}',
          },
        ],
        dependency,
        targetVersion: "^22.1.0",
      }),
    /exact semantic version/,
  );
});

test("repository overlays apply generated dependency metadata without adding paths", () => {
  const files: RepositoryFile[] = [
    { path: "package.json", content: "old" },
    { path: "src/index.ts", content: "source" },
  ];
  assert.deepEqual(
    overlayRepositoryFiles(files, [
      {
        path: "package.json",
        originalContent: "old",
        newContent: "new",
        ruleIds: ["dependency.version.target"],
        rationale: ["target"],
      },
    ]),
    [
      { path: "package.json", content: "new" },
      { path: "src/index.ts", content: "source" },
    ],
  );
});
