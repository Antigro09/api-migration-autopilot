import { getD1 } from "./index";
import migrationSql from "../drizzle/0000_sleepy_landau.sql?raw";

const SCHEMA_VERSION = 1;
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

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
    .prepare(
      "SELECT version FROM _autopilot_schema_versions WHERE version = ? LIMIT 1",
    )
    .bind(SCHEMA_VERSION)
    .first<{ version: number }>();
  if (applied?.version === SCHEMA_VERSION) return;

  const statements = migrationSql
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
      .bind(SCHEMA_VERSION, new Date().toISOString()),
  );

  await database.batch(statements);
}

export function ensureDatabaseSchema(): Promise<void> {
  initialization ??= initialize().catch((error) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}
