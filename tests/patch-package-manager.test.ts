import assert from "node:assert/strict";
import test from "node:test";
import type { RepositoryFile } from "../lib/migration/contracts";
import { packageManager } from "../trigger/patch";

function files(entries: Record<string, string>): RepositoryFile[] {
  return Object.entries(entries).map(([path, content]) => ({ path, content }));
}

test("patch validation selects lifecycle-disabled commands for every supported package manager", () => {
  assert.deepEqual(
    packageManager(
      files({
        "package.json": "{}",
        "package-lock.json": "{}",
      }),
    ),
    {
      kind: "npm",
      install: "npm ci --ignore-scripts",
      runner: "npm run",
    },
  );
  assert.deepEqual(
    packageManager(
      files({
        "package.json": "{}",
        "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      }),
    ),
    {
      kind: "pnpm",
      install: "pnpm install --frozen-lockfile --ignore-scripts",
      runner: "pnpm run",
    },
  );
  assert.deepEqual(
    packageManager(
      files({
        "package.json": '{"packageManager":"yarn@1.22.22"}',
        "yarn.lock": "# yarn lockfile v1",
      }),
    ),
    {
      kind: "yarn-classic",
      install: "yarn install --frozen-lockfile --ignore-scripts",
      runner: "yarn run",
    },
  );
  assert.deepEqual(
    packageManager(
      files({
        "package.json": '{"packageManager":"yarn@4.9.4"}',
        "yarn.lock": "__metadata:\n  version: 8",
      }),
    ),
    {
      kind: "yarn-berry",
      install: "yarn install --immutable --mode=skip-builds",
      runner: "yarn run",
    },
  );
});
