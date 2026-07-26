import { getD1 } from "./index";
import baselineSql from "../drizzle/0000_sleepy_landau.sql?raw";
import patchWorkflowSql from "../drizzle/0001_patch_workflow.sql?raw";

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/**
 * Applied in order. Each entry is recorded in `_autopilot_schema_versions`
 * only after its statements succeed, so an interrupted deployment re-applies
 * the same migration instead of silently skipping it.
 */
const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  { version: 1, sql: baselineSql },
  { version: 2, sql: patchWorkflowSql },
];

let initialization: Promise<void> | undefined;

function idempotentStatement(statement: string): string {
  return statement
    .replace(/^CREATE TABLE\s+/i, "CREATE TABLE IF NOT EXISTS ")
    .replace(
      /^CREATE UNIQUE INDEX\s+/i,
      "CREATE UNIQUE INDEX IF NOT EXISTS ",
    )
    .replace(/^CREATE INDEX\s+/i, "CREATE INDEX IF NOT EXISTS ");
}

async function initialize(): Promise<void> {
  const database = getD1();
  await database
    .prepare(
      `CREATE TABLE IF NOT EXISTS _autopilot_schema_versions (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      )`,
    )
    .run();

  const applied = await database
    .prepare("SELECT version FROM _autopilot_schema_versions")
    .all<{ version: number }>();
  const appliedVersions = new Set(
    applied.results.map((row) => Number(row.version)),
  );

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;

    const statements = migration.sql
      .split(STATEMENT_BREAKPOINT)
      .map((statement) => statement.trim().replace(/;$/, ""))
      .filter(Boolean)
      .map(idempotentStatement)
      .map((statement) => database.prepare(statement));

    statements.push(
      database
        .prepare(
          "INSERT OR IGNORE INTO _autopilot_schema_versions (version, applied_at) VALUES (?, ?)",
        )
        .bind(migration.version, new Date().toISOString()),
    );

    try {
      await database.batch(statements);
    } catch (error) {
      // Two cold-starting isolates can race on the same migration. The batch
      // is atomic, so the loser rolls back; treat it as applied only when the
      // winner actually recorded the version.
      const recorded = await database
        .prepare(
          "SELECT version FROM _autopilot_schema_versions WHERE version = ? LIMIT 1",
        )
        .bind(migration.version)
        .first<{ version: number }>();
      if (!recorded) throw error;
    }
  }
}

export function ensureDatabaseSchema(): Promise<void> {
  initialization ??= initialize().catch((error) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}
