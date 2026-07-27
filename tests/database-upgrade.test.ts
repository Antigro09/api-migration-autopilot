import assert from "node:assert/strict";
import test from "node:test";
import { testDatabase } from "./support/runtime";

const {
  ensureDatabaseSchema,
  resetDatabaseSchemaInitializationForTests,
} = await import("@/db/runtime");

test("runtime reconciles migrations already applied by the hosting platform", async () => {
  await ensureDatabaseSchema();
  testDatabase.sqlite
    .prepare("DELETE FROM _autopilot_schema_versions WHERE version >= 5")
    .run();
  resetDatabaseSchemaInitializationForTests();

  await ensureDatabaseSchema();

  const versions = testDatabase.sqlite
    .prepare(
      "SELECT version FROM _autopilot_schema_versions WHERE version >= 5 ORDER BY version",
    )
    .all() as Array<{ version: number }>;
  assert.deepEqual(
    versions.map((entry) => Number(entry.version)),
    [5, 6, 7],
  );
  const columns = testDatabase.sqlite
    .prepare('PRAGMA table_info("migration_runs")')
    .all() as Array<{ name: string }>;
  assert.ok(columns.some((entry) => entry.name === "retry_count"));
  assert.ok(columns.some((entry) => entry.name === "retry_of_run_id"));
});
