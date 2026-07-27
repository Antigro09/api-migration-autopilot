import { getD1 } from "./index";
import baselineSql from "../drizzle/0000_sleepy_landau.sql?raw";
import patchWorkflowSql from "../drizzle/0001_patch_workflow.sql?raw";
import providerAuthoringSql from "../drizzle/0002_far_chameleon.sql?raw";
import providerReviewSql from "../drizzle/0003_green_ironclad.sql?raw";
import productionControlsSql from "../drizzle/0004_red_enchantress.sql?raw";
import abuseControlsSql from "../drizzle/0005_normal_sentry.sql?raw";
import workflowResultReceiptsSql from "../drizzle/0006_brainy_mac_gargan.sql?raw";

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const ALTER_ADD_COLUMN =
  /^ALTER TABLE\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?\s+ADD\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?\s+/i;

/**
 * Applied in order. Each entry is recorded in `_autopilot_schema_versions`
 * only after its statements succeed, so an interrupted deployment re-applies
 * the same migration instead of silently skipping it.
 */
const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  { version: 1, sql: baselineSql },
  { version: 2, sql: patchWorkflowSql },
  { version: 3, sql: providerAuthoringSql },
  { version: 4, sql: providerReviewSql },
  { version: 5, sql: productionControlsSql },
  { version: 6, sql: abuseControlsSql },
  { version: 7, sql: workflowResultReceiptsSql },
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

async function alterColumnAlreadyExists(
  database: ReturnType<typeof getD1>,
  statement: string,
): Promise<boolean> {
  const match = ALTER_ADD_COLUMN.exec(statement);
  if (!match) return false;
  const table = match[1] as string;
  const column = match[2] as string;
  const result = await database
    .prepare(`PRAGMA table_info("${table}")`)
    .all<{ name: string }>();
  return result.results.some((entry) => entry.name === column);
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

    const migrationStatements = migration.sql
      .split(STATEMENT_BREAKPOINT)
      .map((statement) => statement.trim().replace(/;$/, ""))
      .filter(Boolean)
      .map(idempotentStatement);
    const statements = [];
    for (const statement of migrationStatements) {
      // Sites may apply packaged Drizzle migrations before the Worker starts.
      // Reconcile that valid state into the runtime ledger rather than
      // repeatedly failing on SQLite's non-idempotent ADD COLUMN syntax.
      if (await alterColumnAlreadyExists(database, statement)) continue;
      statements.push(database.prepare(statement));
    }

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

/** Allows the upgrade-reconciliation path to be exercised in isolated tests. */
export function resetDatabaseSchemaInitializationForTests(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Schema initialization cannot be reset in production.");
  }
  initialization = undefined;
}
