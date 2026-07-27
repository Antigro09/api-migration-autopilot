import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { CommandExitError, Sandbox } from "e2b";
import type { RepositoryFile } from "@/lib/migration/contracts";
import { normalizeRepositoryPath } from "@/lib/migration/patch-security";
import type {
  IndexedBinding,
  IndexedFile,
  IndexedUsage,
  RepositorySymbolIndex,
} from "@/lib/migration/symbol-index";
import { requireSecret } from "@/lib/platform/config";

const MAX_FILES = 2_000;
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_MS = 20 * 60 * 1_000;
const CODE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;

const INDEXER_SOURCE = String.raw`
const fs = require("node:fs");
const ts = require("./typescript.js");
const input = JSON.parse(fs.readFileSync("./input.json", "utf8"));

function rootAndMembers(node) {
  if (ts.isIdentifier(node)) return { localName: node.text, memberPath: [] };
  if (ts.isPropertyAccessExpression(node)) {
    const parent = rootAndMembers(node.expression);
    return parent ? { localName: parent.localName, memberPath: [...parent.memberPath, node.name.text] } : null;
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    const parent = rootAndMembers(node.expression);
    return parent ? { localName: parent.localName, memberPath: [...parent.memberPath, node.argumentExpression.text] } : null;
  }
  return null;
}

function literalModule(call) {
  return ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    call.expression.text === "require" &&
    call.arguments.length === 1 &&
    ts.isStringLiteral(call.arguments[0])
      ? call.arguments[0].text
      : null;
}

function indexFile(file) {
  const kind = file.path.endsWith(".tsx") || file.path.endsWith(".jsx")
    ? ts.ScriptKind.TSX
    : file.path.endsWith(".js") || file.path.endsWith(".mjs") || file.path.endsWith(".cjs")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, kind);
  const bindings = [];
  const aliases = new Map();

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const moduleName = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause?.name) bindings.push({ moduleName, importedName: "default", localName: clause.name.text, kind: "default", start: clause.name.getStart(source), end: clause.name.end });
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        const name = clause.namedBindings.name;
        bindings.push({ moduleName, importedName: "*", localName: name.text, kind: "namespace", start: name.getStart(source), end: name.end });
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const item of clause.namedBindings.elements) {
          bindings.push({ moduleName, importedName: (item.propertyName ?? item.name).text, localName: item.name.text, kind: "named", start: item.name.getStart(source), end: item.name.end });
        }
      }
    }
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && ts.isStringLiteral(statement.moduleReference.expression)) {
      bindings.push({ moduleName: statement.moduleReference.expression.text, importedName: "*", localName: statement.name.text, kind: "require", start: statement.name.getStart(source), end: statement.name.end });
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        const direct = initializer ? literalModule(initializer) : null;
        const property = initializer && ts.isPropertyAccessExpression(initializer)
          ? literalModule(initializer.expression)
          : null;
        const moduleName = direct ?? property;
        if (moduleName && ts.isIdentifier(declaration.name)) {
          bindings.push({ moduleName, importedName: property ? initializer.name.text : "*", localName: declaration.name.text, kind: "require", start: declaration.name.getStart(source), end: declaration.name.end });
        } else if (moduleName && ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            bindings.push({ moduleName, importedName: element.propertyName?.getText(source) ?? element.name.text, localName: element.name.text, kind: "require", start: element.name.getStart(source), end: element.name.end });
          }
        } else if (ts.isIdentifier(declaration.name) && initializer && ts.isIdentifier(initializer)) {
          aliases.set(declaration.name.text, initializer.text);
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const moduleName = statement.moduleSpecifier.text;
      if (!statement.exportClause) {
        bindings.push({ moduleName, importedName: "*", localName: "*", kind: "reexport", start: statement.getStart(source), end: statement.end });
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const item of statement.exportClause.elements) {
          bindings.push({ moduleName, importedName: (item.propertyName ?? item.name).text, localName: item.name.text, kind: "reexport", start: item.getStart(source), end: item.end });
        }
      }
    }
  }

  const bindingNames = new Set(bindings.filter((binding) => binding.localName !== "*").map((binding) => binding.localName));
  for (const [alias, target] of [...aliases]) if (!bindingNames.has(target)) aliases.delete(alias);
  const usages = [];
  const addExpression = (kind, expression, argumentCount) => {
    const root = rootAndMembers(expression);
    if (!root) return;
    const localName = aliases.get(root.localName) ?? root.localName;
    if (!bindingNames.has(localName)) return;
    usages.push({ kind, localName, memberPath: root.memberPath, start: expression.getStart(source), end: expression.end, argumentCount });
  };
  function visit(node) {
    if (ts.isCallExpression(node)) addExpression("call", node.expression, node.arguments.length);
    if (ts.isNewExpression(node)) addExpression("new", node.expression, node.arguments?.length ?? 0);
    if (ts.isIdentifier(node)) {
      const localName = aliases.get(node.text) ?? node.text;
      const parent = node.parent;
      if (
        bindingNames.has(localName) &&
        !ts.isImportClause(parent) &&
        !ts.isImportSpecifier(parent) &&
        !ts.isNamespaceImport(parent) &&
        !ts.isVariableDeclaration(parent) &&
        !(ts.isPropertyAccessExpression(parent) && parent.name === node) &&
        !ts.isCallExpression(parent) &&
        !ts.isNewExpression(parent)
      ) {
        const root = ts.isPropertyAccessExpression(parent) && parent.expression === node ? rootAndMembers(parent) : rootAndMembers(node);
        if (root) usages.push({ kind: "reference", localName, memberPath: root.memberPath, start: node.getStart(source), end: root.memberPath.length ? parent.end : node.end });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const unique = new Map();
  for (const usage of usages) unique.set([usage.kind, usage.localName, usage.memberPath.join("."), usage.start, usage.end].join(":"), usage);
  return {
    path: file.path,
    bindings,
    usages: [...unique.values()].sort((a, b) => a.start - b.start),
    syntaxErrors: source.parseDiagnostics.length,
  };
}

const output = { files: input.files.map(indexFile), skipped: [] };
process.stdout.write(JSON.stringify(output));
`;

export interface AssessmentSandboxRunner {
  index(input: {
    runId: string;
    files: readonly RepositoryFile[];
  }): Promise<{
    index: RepositorySymbolIndex;
    sandboxId: string;
    sandboxImageVersion: string;
    destroyedAt: string;
    network: "none";
  }>;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`Assessment sandbox returned an invalid ${label}.`);
  }
  return value;
}

function parseBinding(value: unknown): IndexedBinding {
  if (!value || typeof value !== "object") {
    throw new Error("Assessment sandbox returned an invalid binding.");
  }
  const row = value as Partial<IndexedBinding>;
  const kinds = ["default", "namespace", "named", "require", "reexport"];
  if (
    typeof row.moduleName !== "string" ||
    typeof row.importedName !== "string" ||
    typeof row.localName !== "string" ||
    !kinds.includes(row.kind ?? "")
  ) {
    throw new Error("Assessment sandbox returned malformed binding metadata.");
  }
  return {
    moduleName: row.moduleName.slice(0, 214),
    importedName: row.importedName.slice(0, 256),
    localName: row.localName.slice(0, 256),
    kind: row.kind as IndexedBinding["kind"],
    start: boundedInteger(row.start, 0, 100_000_000, "binding start"),
    end: boundedInteger(row.end, 0, 100_000_000, "binding end"),
  };
}

function parseUsage(value: unknown): IndexedUsage {
  if (!value || typeof value !== "object") {
    throw new Error("Assessment sandbox returned an invalid usage.");
  }
  const row = value as Partial<IndexedUsage>;
  if (
    !["call", "new", "reference"].includes(row.kind ?? "") ||
    typeof row.localName !== "string" ||
    !Array.isArray(row.memberPath) ||
    !row.memberPath.every((member) => typeof member === "string")
  ) {
    throw new Error("Assessment sandbox returned malformed usage metadata.");
  }
  return {
    kind: row.kind as IndexedUsage["kind"],
    localName: row.localName.slice(0, 256),
    memberPath: row.memberPath.slice(0, 32).map((member) => member.slice(0, 256)),
    start: boundedInteger(row.start, 0, 100_000_000, "usage start"),
    end: boundedInteger(row.end, 0, 100_000_000, "usage end"),
    ...(row.argumentCount === undefined
      ? {}
      : {
          argumentCount: boundedInteger(
            row.argumentCount,
            0,
            10_000,
            "argument count",
          ),
        }),
  };
}

function parseIndex(value: unknown): RepositorySymbolIndex {
  if (!value || typeof value !== "object") {
    throw new Error("Assessment sandbox returned an invalid index.");
  }
  const rows = (value as { files?: unknown }).files;
  if (!Array.isArray(rows) || rows.length > MAX_FILES) {
    throw new Error("Assessment sandbox returned too many indexed files.");
  }
  const files: IndexedFile[] = rows.map((value) => {
    if (!value || typeof value !== "object") {
      throw new Error("Assessment sandbox returned an invalid file index.");
    }
    const row = value as Partial<IndexedFile>;
    if (
      typeof row.path !== "string" ||
      !Array.isArray(row.bindings) ||
      !Array.isArray(row.usages) ||
      row.bindings.length > 10_000 ||
      row.usages.length > 100_000
    ) {
      throw new Error("Assessment sandbox returned malformed file metadata.");
    }
    return {
      path: normalizeRepositoryPath(row.path),
      bindings: row.bindings.map(parseBinding),
      usages: row.usages.map(parseUsage),
      syntaxErrors: boundedInteger(
        row.syntaxErrors,
        0,
        100_000,
        "syntax diagnostic count",
      ),
    };
  });
  return { files, skipped: [] };
}

export class E2BAssessmentSandboxRunner implements AssessmentSandboxRunner {
  async index(input: {
    runId: string;
    files: readonly RepositoryFile[];
  }): Promise<{
    index: RepositorySymbolIndex;
    sandboxId: string;
    sandboxImageVersion: string;
    destroyedAt: string;
    network: "none";
  }> {
    const files = input.files
      .filter((file) => CODE_EXTENSION.test(file.path))
      .map((file) => ({
        path: normalizeRepositoryPath(file.path),
        content: file.content,
      }));
    if (files.length === 0) {
      return {
        index: { files: [], skipped: [] },
        sandboxId: "not-created-no-source",
        sandboxImageVersion: requireSecret("E2B_ASSESSMENT_IMAGE_VERSION"),
        destroyedAt: new Date().toISOString(),
        network: "none",
      };
    }
    if (files.length > MAX_FILES) {
      throw new Error(
        "Assessment supports at most 2,000 Node.js/TypeScript files.",
      );
    }
    const encodedInput = new TextEncoder().encode(JSON.stringify({ files }));
    if (encodedInput.byteLength > MAX_SOURCE_BYTES) {
      throw new Error("Assessment source exceeds the 50 MiB sandbox limit.");
    }

    const require = createRequire(import.meta.url);
    const typescriptPath = require.resolve("typescript/lib/typescript.js");
    const typescriptRuntime = await readFile(typescriptPath);
    const sandboxImageVersion = requireSecret(
      "E2B_ASSESSMENT_IMAGE_VERSION",
    );
    const sandbox = await Sandbox.create(requireSecret("E2B_TEMPLATE_ID"), {
      apiKey: requireSecret("E2B_API_KEY"),
      timeoutMs: MAX_RUNTIME_MS,
      secure: true,
      allowInternetAccess: false,
      network: {
        denyOut: ["0.0.0.0/0"],
        allowPublicTraffic: false,
      },
      lifecycle: { onTimeout: "kill" },
      metadata: {
        product: "api-migration-autopilot",
        phase: "analysis",
        runId: input.runId.slice(0, 128),
      },
      envs: {},
    });
    let index: RepositorySymbolIndex;
    try {
      const root = "/home/user/autopilot-analysis";
      await sandbox.files.makeDir(root);
      await sandbox.files.write([
        {
          path: `${root}/typescript.js`,
          data: Uint8Array.from(typescriptRuntime).buffer,
        },
        { path: `${root}/indexer.cjs`, data: INDEXER_SOURCE },
        { path: `${root}/input.json`, data: encodedInput.buffer },
      ]);
      const result = await sandbox.commands.run(
        `node ${root}/indexer.cjs`,
        {
          cwd: root,
          requestTimeoutMs: MAX_RUNTIME_MS,
        },
      );
      const output = new TextEncoder().encode(result.stdout);
      if (output.byteLength === 0 || output.byteLength > MAX_INDEX_BYTES) {
        throw new Error(
          "Assessment sandbox returned an empty or oversized symbol index.",
        );
      }
      index = parseIndex(JSON.parse(result.stdout));
    } catch (error) {
      if (error instanceof CommandExitError) {
        throw new Error(
          `Assessment sandbox failed with exit code ${error.exitCode}.`,
        );
      }
      throw error;
    } finally {
      await sandbox.kill();
    }
    return {
      index,
      sandboxId: sandbox.sandboxId,
      sandboxImageVersion,
      destroyedAt: new Date().toISOString(),
      network: "none",
    };
  }
}
