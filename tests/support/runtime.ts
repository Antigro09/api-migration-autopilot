import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/**
 * Test runtime for modules that target the Cloudflare Workers runtime.
 *
 * `cloudflare:workers` and Vite's `?raw` SQL imports do not exist under plain
 * Node, so this module installs resolve/load hooks for both and then binds a
 * real SQLite database and an in-memory object store to the same `env` shape
 * the worker sees. Importing it has side effects and must happen before any
 * application module is imported — use a dynamic `import()` for those.
 */

const CLOUDFLARE_STUB = "autopilot-test:cloudflare-workers";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { url: CLOUDFLARE_STUB, shortCircuit: true };
    }
    if (specifier.endsWith(".sql?raw")) {
      return {
        url: new URL(specifier, context.parentURL).href,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === CLOUDFLARE_STUB) {
      return {
        format: "module",
        source: "export const env = globalThis.__AUTOPILOT_TEST_ENV__;",
        shortCircuit: true,
      };
    }
    if (url.endsWith(".sql?raw")) {
      const source = readFileSync(
        fileURLToPath(url.slice(0, -"?raw".length)),
        "utf8",
      );
      return {
        format: "module",
        source: `export default ${JSON.stringify(source)};`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

type SqlValue = null | number | bigint | string | Uint8Array;

function coerce(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  return String(value);
}

function isQuery(sql: string): boolean {
  return /^\s*(?:select|pragma|with)\b/i.test(sql);
}

class TestStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly params: SqlValue[] = [],
  ) {}

  bind(...params: unknown[]): TestStatement {
    return new TestStatement(this.database, this.sql, params.map(coerce));
  }

  first<T>(): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.params);
    return Promise.resolve((row ?? null) as T | null);
  }

  all<T>(): Promise<{ results: T[]; success: true }> {
    const rows = this.database.prepare(this.sql).all(...this.params);
    return Promise.resolve({ results: rows as T[], success: true });
  }

  run(): Promise<{ success: true; meta: { changes: number } }> {
    if (isQuery(this.sql)) {
      this.database.prepare(this.sql).all(...this.params);
      return Promise.resolve({ success: true, meta: { changes: 0 } });
    }
    const info = this.database.prepare(this.sql).run(...this.params);
    return Promise.resolve({
      success: true,
      meta: { changes: Number(info.changes) },
    });
  }

  execute(): { results: unknown[]; meta: { changes: number } } {
    if (isQuery(this.sql)) {
      return {
        results: this.database.prepare(this.sql).all(...this.params),
        meta: { changes: 0 },
      };
    }
    const info = this.database.prepare(this.sql).run(...this.params);
    return { results: [], meta: { changes: Number(info.changes) } };
  }
}

class TestDatabase {
  readonly sqlite = new DatabaseSync(":memory:");

  constructor() {
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
  }

  prepare(sql: string): TestStatement {
    return new TestStatement(this.sqlite, sql);
  }

  /** Mirrors D1's atomic batch: all statements commit together or none do. */
  batch(statements: TestStatement[]): Promise<
    Array<{ results: unknown[]; success: true; meta: { changes: number } }>
  > {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => {
        const outcome = statement.execute();
        return { ...outcome, success: true as const };
      });
      this.sqlite.exec("COMMIT");
      return Promise.resolve(results);
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      return Promise.reject(error);
    }
  }
}

type StoredObject = {
  body: Uint8Array;
  etag: string;
  uploaded: Date;
  customMetadata: Record<string, string>;
};

class TestBucket {
  readonly objects = new Map<string, StoredObject>();

  put(
    key: string,
    body: ArrayBuffer | ArrayBufferView | Blob | string,
    options?: { customMetadata?: Record<string, string> },
  ) {
    const bytes =
      typeof body === "string"
        ? new TextEncoder().encode(body)
        : body instanceof Uint8Array
          ? new Uint8Array(body)
          : new Uint8Array(body as ArrayBuffer);
    const object: StoredObject = {
      body: bytes,
      etag: `etag-${this.objects.size + 1}`,
      uploaded: new Date(),
      customMetadata: options?.customMetadata ?? {},
    };
    this.objects.set(key, object);
    return Promise.resolve({
      key,
      etag: object.etag,
      size: bytes.byteLength,
      uploaded: object.uploaded,
    });
  }

  get(key: string) {
    const object = this.objects.get(key);
    if (!object) return Promise.resolve(null);
    return Promise.resolve({
      key,
      etag: object.etag,
      size: object.body.byteLength,
      uploaded: object.uploaded,
      arrayBuffer: () =>
        Promise.resolve(
          object.body.buffer.slice(
            object.body.byteOffset,
            object.body.byteOffset + object.body.byteLength,
          ) as ArrayBuffer,
        ),
      text: () => Promise.resolve(new TextDecoder().decode(object.body)),
    });
  }

  delete(key: string | string[]) {
    for (const entry of Array.isArray(key) ? key : [key]) {
      this.objects.delete(entry);
    }
    return Promise.resolve();
  }

  list(options?: { prefix?: string; cursor?: string }) {
    const prefix = options?.prefix ?? "";
    return Promise.resolve({
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false as const,
      cursor: undefined,
    });
  }
}

export const testDatabase = new TestDatabase();
export const testBucket = new TestBucket();

process.env.APP_BASE_URL = "https://autopilot.test";
process.env.ARTIFACT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.WORKFLOW_CALLBACK_SECRET = "test-workflow-callback-secret";
process.env.INTERNAL_OPERATOR_EMAILS = "";

(globalThis as { __AUTOPILOT_TEST_ENV__?: unknown }).__AUTOPILOT_TEST_ENV__ = {
  DB: testDatabase,
  ARTIFACTS: testBucket,
};

/** Removes every row so a test file can start from a clean control plane. */
export function resetControlPlane(): void {
  const tables = testDatabase.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_autopilot_schema_versions'",
    )
    .all() as Array<{ name: string }>;
  testDatabase.sqlite.exec("PRAGMA foreign_keys = OFF;");
  for (const table of tables) {
    testDatabase.sqlite.exec(`DELETE FROM "${table.name}"`);
  }
  testDatabase.sqlite.exec("PRAGMA foreign_keys = ON;");
  testBucket.objects.clear();
}
