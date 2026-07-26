import type {
  Confidence,
  DependencyResolution,
  MigrationAssessment,
  MigrationFinding,
  RepositoryFile,
  SourceLocation,
} from "./contracts.js";
import { stripeChangeById, stripeV20ToV22Spec } from "./specs/stripe-v20-v22.js";

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".cjs", ".cts", ".mjs", ".mts"]);
const DECIMAL_FIELDS = [
  "amount_decimal",
  "flat_amount_decimal",
  "fx_rate",
  "gross_amount_decimal",
  "local_amount_decimal",
  "metric_tons",
  "metric_tons_available",
  "national_amount_decimal",
  "percent_ownership",
  "quantity_decimal",
  "unit_amount_decimal",
  "unit_cost_decimal",
] as const;

interface PatternFinding {
  readonly ruleId: string;
  readonly start: number;
  readonly end: number;
  readonly message: string;
  readonly confidence: Confidence;
  readonly autoPatchEligible: boolean;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

function extension(path: string): string {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index).toLowerCase();
}

function maskComments(source: string): string {
  let result = "";
  let state: "code" | "single" | "double" | "template" | "line-comment" | "block-comment" = "code";
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (state === "line-comment") {
      if (current === "\n") {
        state = "code";
        result += "\n";
      } else {
        result += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += current === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "code") {
      if (current === "/" && next === "/") {
        result += "  ";
        index += 1;
        state = "line-comment";
        continue;
      }
      if (current === "/" && next === "*") {
        result += "  ";
        index += 1;
        state = "block-comment";
        continue;
      }
      if (current === "'") state = "single";
      if (current === '"') state = "double";
      if (current === "`") state = "template";
      result += current;
      continue;
    }

    result += current;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (current === "\\") {
      escaped = true;
      continue;
    }
    if (
      (state === "single" && current === "'") ||
      (state === "double" && current === '"') ||
      (state === "template" && current === "`")
    ) {
      state = "code";
    }
  }

  return result;
}

function locationAt(source: string, start: number, end: number): SourceLocation {
  const prefix = source.slice(0, start);
  const lines = prefix.split("\n");
  return {
    start,
    end,
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function excerptAt(source: string, start: number, end: number): string {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const newline = source.indexOf("\n", end);
  const lineEnd = newline < 0 ? source.length : newline;
  const excerpt = source.slice(lineStart, lineEnd).trim();
  return excerpt.length > 280 ? `${excerpt.slice(0, 277)}...` : excerpt;
}

function matches(source: string, expression: RegExp): RegExpExecArray[] {
  const flags = expression.flags.includes("g") ? expression.flags : `${expression.flags}g`;
  const matcher = new RegExp(expression.source, flags);
  const found: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(source)) !== null) {
    found.push(match);
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return found;
}

function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripeBindings(source: string): Set<string> {
  const result = new Set<string>();
  const patterns = [
    /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+["']stripe["']/g,
    /\bimport\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']stripe["']\s*\)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']stripe["']\s*\)(?:\.(?:default|Stripe))?/g,
    /\b(?:const|let|var)\s*\{\s*Stripe\s*:\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*require\(\s*["']stripe["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of matches(source, pattern)) {
      if (match[1]) result.add(match[1]);
    }
  }
  if (/\b(?:import|require)\b[\s\S]{0,100}["']stripe["']/.test(source)) result.add("Stripe");
  return result;
}

function addPattern(
  output: PatternFinding[],
  source: string,
  expression: RegExp,
  create: (match: RegExpExecArray) => Omit<PatternFinding, "start" | "end"> & { startOffset?: number; endOffset?: number },
): void {
  for (const match of matches(source, expression)) {
    const details = create(match);
    const start = match.index + (details.startOffset ?? 0);
    const end = match.index + (details.endOffset ?? match[0].length);
    output.push({ ...details, start, end });
  }
}

function analyzeCode(source: string): PatternFinding[] {
  const code = maskComments(source);
  const output: PatternFinding[] = [];
  const bindings = stripeBindings(code);

  addPattern(
    output,
    code,
    /\brequire\(\s*["']stripe["']\s*\)\.(?:default|Stripe)\b/g,
    () => ({
      ruleId: "stripe.import.cjs-entrypoint",
      message: "The v22 CommonJS export no longer exposes this property.",
      confidence: "certain",
      autoPatchEligible: true,
    }),
  );
  addPattern(
    output,
    code,
    /\b(?:const|let|var)\s*\{\s*Stripe(?:\s*:\s*[A-Za-z_$][\w$]*)?\s*\}\s*=\s*require\(\s*["']stripe["']\s*\)/g,
    () => ({
      ruleId: "stripe.import.cjs-entrypoint",
      message: "Destructuring Stripe from the CommonJS entry point is unsupported in v22.",
      confidence: "certain",
      autoPatchEligible: true,
    }),
  );

  for (const binding of bindings) {
    const escaped = escapeExpression(binding);
    const callPattern = new RegExp(`\\b${escaped}\\s*\\(`, "g");
    for (const match of matches(code, callPattern)) {
      const before = code.slice(Math.max(0, match.index - 12), match.index);
      if (/\bnew\s*$/.test(before)) continue;
      if (/\b(?:function|class)\s*$/.test(before)) continue;
      output.push({
        ruleId: "stripe.constructor.new",
        start: match.index,
        end: match.index + binding.length,
        message: `Call ${binding} with new for the v22 ES class export.`,
        confidence: "high",
        autoPatchEligible: true,
        metadata: { binding },
      });
    }

    addPattern(
      output,
      code,
      new RegExp(`\\b${escaped}\\.StripeContext\\b`, "g"),
      () => ({
        ruleId: "stripe.type.context",
        message: "StripeContext is renamed to StripeContextType in v22.",
        confidence: "certain",
        autoPatchEligible: true,
        metadata: { binding },
      }),
    );

    addPattern(
      output,
      code,
      new RegExp(`\\b${escaped}\\.errors\\.StripeError\\b`, "g"),
      (match) => {
        const after = code.slice(match.index + match[0].length, match.index + match[0].length + 16);
        const before = code.slice(Math.max(0, match.index - 16), match.index);
        const runtimeUse = /\b(?:new|instanceof)\s*$/.test(before) || /^\s*\(/.test(after);
        return {
          ruleId: "stripe.type.error",
          message: runtimeUse
            ? "Runtime StripeError usage is supported, but its use as a type must be reviewed."
            : "Use Stripe.ErrorType for an instance type annotation in v22.",
          confidence: runtimeUse ? "medium" : "high",
          autoPatchEligible: !runtimeUse,
          metadata: { binding, runtimeUse },
        };
      },
    );

    const decimalFieldAlternation = DECIMAL_FIELDS.map(escapeExpression).join("|");
    addPattern(
      output,
      code,
      new RegExp(
        `\\b(${decimalFieldAlternation})\\s*:\\s*(["'])([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))\\2`,
        "g",
      ),
      (match) => ({
        ruleId: "stripe.decimal.write",
        message: `${match[1]} is a Decimal field; construct the literal with ${binding}.Decimal.from().`,
        confidence: "high",
        autoPatchEligible: true,
        metadata: { binding, field: match[1] ?? "", decimal: match[3] ?? "" },
      }),
    );
  }

  const decimalReadAlternation = DECIMAL_FIELDS.map(escapeExpression).join("|");
  addPattern(
    output,
    code,
    new RegExp(`\\.(${decimalReadAlternation})\\b`, "g"),
    (match) => ({
      ruleId: "stripe.decimal.read",
      message: `${match[1]} now returns Stripe.Decimal; review string comparison and serialization behavior.`,
      confidence: "medium",
      autoPatchEligible: false,
      metadata: { field: match[1] ?? "" },
    }),
  );

  addPattern(
    output,
    code,
    /\b([A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\([\s\S]{0,1200}?,\s*\{\s*host\s*:\s*(["'])([^"']+)\2\s*\}\s*\)/g,
    (match) => ({
      ruleId: "stripe.request.host",
      message: "Move this per-request host override to the Stripe client configuration.",
      confidence: "high",
      autoPatchEligible: true,
      metadata: { clientBinding: match[1] ?? "", host: match[3] ?? "" },
    }),
  );

  addPattern(
    output,
    code,
    /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){2,}\s*\([\s\S]{0,800}?,\s*(["'])sk_(?:test|live)_[^"']+\1\s*\)/g,
    () => ({
      ruleId: "stripe.request.legacy-arguments",
      message: "A plain API key request argument is removed in v22; use RequestOptions.apiKey.",
      confidence: "high",
      autoPatchEligible: false,
      metadata: { kind: "plain-api-key" },
    }),
  );

  addPattern(
    output,
    code,
    /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){2,}\s*\([\s\S]{0,800}?(?:,\s*)?(?:function\s*\(|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
    () => ({
      ruleId: "stripe.request.legacy-arguments",
      message: "Callback-style Stripe methods are removed in v22; migrate the control flow to promises.",
      confidence: "medium",
      autoPatchEligible: false,
      metadata: { kind: "callback" },
    }),
  );

  const unique = new Map<string, PatternFinding>();
  for (const finding of output) {
    unique.set(`${finding.ruleId}:${finding.start}:${finding.end}`, finding);
  }
  return [...unique.values()].sort((left, right) => left.start - right.start);
}

function parseVersion(value: string | undefined): readonly [number, number, number] | undefined {
  if (!value) return undefined;
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isSupportedSource(value: string | undefined): boolean {
  const version = parseVersion(value);
  return Boolean(version && compareVersion(version, [20, 3, 0]) >= 0 && compareVersion(version, [21, 0, 0]) < 0);
}

function targetSatisfied(value: string | undefined): boolean {
  const version = parseVersion(value);
  return Boolean(version && compareVersion(version, [22, 1, 0]) >= 0);
}

function packageManifest(files: readonly RepositoryFile[]): {
  declaredRange?: string;
  path?: string;
  nodeRange?: string;
} {
  for (const file of files) {
    if (file.path === "package.json" || file.path.endsWith("/package.json")) {
      try {
        const parsed = JSON.parse(file.content) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
          optionalDependencies?: Record<string, string>;
          engines?: { node?: string };
        };
        const declaredRange =
          parsed.dependencies?.stripe ??
          parsed.devDependencies?.stripe ??
          parsed.peerDependencies?.stripe ??
          parsed.optionalDependencies?.stripe;
        if (declaredRange) return { declaredRange, path: file.path, nodeRange: parsed.engines?.node };
      } catch {
        // Malformed manifests are reported by the caller as unresolved dependency metadata.
      }
    }
  }
  return {};
}

function lockfileResolution(files: readonly RepositoryFile[]): { version?: string; path?: string } {
  for (const file of files) {
    if (file.path === "package-lock.json" || file.path.endsWith("/package-lock.json")) {
      try {
        const parsed = JSON.parse(file.content) as {
          packages?: Record<string, { version?: string }>;
          dependencies?: Record<string, { version?: string }>;
        };
        const version = parsed.packages?.["node_modules/stripe"]?.version ?? parsed.dependencies?.stripe?.version;
        if (version) return { version, path: file.path };
      } catch {
        // Continue to the conservative text parsers.
      }
    }
  }

  for (const file of files) {
    if (/(?:^|\/)pnpm-lock\.yaml$/.test(file.path)) {
      const direct = file.content.match(/(?:^|\n)\s{2,}stripe:\s*\n(?:[^\n]*\n){0,4}?\s+version:\s*['"]?(\d+\.\d+\.\d+)/);
      const packageKey = file.content.match(/(?:^|\n)\s{2,}['"]?\/?stripe@(\d+\.\d+\.\d+)/);
      const version = direct?.[1] ?? packageKey?.[1];
      if (version) return { version, path: file.path };
    }
    if (/(?:^|\/)yarn\.lock$/.test(file.path)) {
      const block = file.content.match(/(?:^|\n)(?:"?stripe@[^:\n]+"?):\s*\n(?:[^\n]*\n){0,3}?\s+version\s+["'](\d+\.\d+\.\d+)["']/);
      if (block?.[1]) return { version: block[1], path: file.path };
    }
  }
  return {};
}

function resolveDependency(files: readonly RepositoryFile[]): DependencyResolution {
  const manifest = packageManifest(files);
  const lockfile = lockfileResolution(files);
  const effectiveVersion = lockfile.version ?? manifest.declaredRange;
  const warnings: string[] = [];
  if (!manifest.declaredRange) warnings.push("No package.json declares the stripe dependency.");
  if (!lockfile.version) warnings.push("No exact stripe version was resolved from a supported lockfile.");
  if (!manifest.nodeRange) warnings.push("No Node.js runtime range is declared in the selected package.json.");

  return {
    packageName: "stripe",
    declaredRange: manifest.declaredRange,
    resolvedVersion: lockfile.version,
    manifestPath: manifest.path,
    lockfilePath: lockfile.path,
    supportedSource: isSupportedSource(effectiveVersion),
    targetSatisfied: targetSatisfied(effectiveVersion),
    warnings,
  };
}

function findingFromPattern(file: RepositoryFile, pattern: PatternFinding): MigrationFinding {
  const change = stripeChangeById.get(pattern.ruleId);
  if (!change) throw new Error(`Unknown Stripe migration rule: ${pattern.ruleId}`);
  return {
    id: `${pattern.ruleId}:${file.path}:${pattern.start}`,
    ruleId: pattern.ruleId,
    path: file.path,
    location: locationAt(file.content, pattern.start, pattern.end),
    excerpt: excerptAt(file.content, pattern.start, pattern.end),
    message: pattern.message,
    confidence: pattern.confidence,
    coverage: pattern.autoPatchEligible ? "full" : "partial",
    autoPatchEligible: pattern.autoPatchEligible,
    evidence: change.citations,
    metadata: pattern.metadata,
  };
}

export function assessStripeV20ToV22(files: readonly RepositoryFile[]): MigrationAssessment {
  const dependency = resolveDependency(files);
  const findings: MigrationFinding[] = [];
  const scannedFiles: string[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const file of files) {
    const fileExtension = extension(file.path);
    if (!CODE_EXTENSIONS.has(fileExtension)) {
      if (!/(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|package\.json)$/.test(file.path)) {
        skipped.push({ path: file.path, reason: "Unsupported file type for the Node.js/TypeScript analyzer." });
      }
      continue;
    }
    if (file.content.includes("\0")) {
      skipped.push({ path: file.path, reason: "Binary content is never analyzed." });
      continue;
    }
    scannedFiles.push(file.path);
    findings.push(...analyzeCode(file.content).map((pattern) => findingFromPattern(file, pattern)));
  }

  const hasPartial = findings.some((finding) => !finding.autoPatchEligible) || skipped.length > 0;
  const status =
    findings.length === 0
      ? "no-impact"
      : hasPartial
        ? "partial-coverage"
        : "impact-found";

  return {
    specId: stripeV20ToV22Spec.id,
    specRevision: stripeV20ToV22Spec.revision,
    status,
    dependency,
    findings,
    scannedFiles,
    skipped,
  };
}

export const stripeAnalyzerVersion = "stripe-v20-v22-analyzer/1.0.0";

