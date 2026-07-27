import type {
  MigrationChangeV1,
  MigrationCitationV1,
  MigrationSpecV1,
} from "@/lib/domain";
import type {
  Confidence,
  MigrationAssessment,
  MigrationFinding,
  RepositoryFile,
  SourceCitation,
  SourceLocation,
} from "./contracts";
import { assessStripeV20ToV22 } from "./analyzer";
import {
  isDependencyMetadata,
  resolvePackageDependency,
} from "./dependencies";
import {
  buildRepositorySymbolIndex,
  type IndexedBinding,
  type IndexedUsage,
  type RepositorySymbolIndex,
  symbolIndexerVersion,
} from "./symbol-index";

const CODE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;

function locationAt(
  source: string,
  start: number,
  end: number,
): SourceLocation {
  const lines = source.slice(0, start).split("\n");
  return {
    start,
    end,
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function excerptAt(source: string, start: number, end: number): string {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const nextLine = source.indexOf("\n", end);
  const lineEnd = nextLine < 0 ? source.length : nextLine;
  const excerpt = source.slice(lineStart, lineEnd).trim();
  return excerpt.length > 280 ? `${excerpt.slice(0, 277)}...` : excerpt;
}

function evidenceFor(
  spec: MigrationSpecV1,
  citations: readonly MigrationCitationV1[],
): SourceCitation[] {
  const artifacts = new Map(
    spec.sourceArtifacts.map((artifact) => [artifact.id, artifact]),
  );
  return citations.map((citation) => {
    const artifact = artifacts.get(citation.artifactId);
    return {
      title: `${artifact?.title ?? "Provider artifact"} — ${citation.locator}`,
      ...(artifact?.externalUrl ? { url: artifact.externalUrl } : {}),
      ...(citation.excerpt ? { excerpt: citation.excerpt } : {}),
    };
  });
}

function bindingMatches(
  binding: IndexedBinding,
  detector: MigrationChangeV1["detectors"][number],
): boolean {
  if (binding.moduleName !== detector.moduleName) return false;
  if (!detector.symbol) return true;
  return (
    binding.importedName === detector.symbol ||
    binding.localName === detector.symbol ||
    (binding.importedName === "default" && binding.localName === detector.symbol)
  );
}

function usageMatches(
  usage: IndexedUsage,
  bindings: readonly IndexedBinding[],
  detector: MigrationChangeV1["detectors"][number],
): boolean {
  const matchingBindings = bindings.filter((binding) =>
    bindingMatches(binding, detector),
  );
  if (
    !matchingBindings.some((binding) => binding.localName === usage.localName)
  ) {
    return false;
  }
  if (
    detector.member &&
    !usage.memberPath.includes(detector.member) &&
    usage.memberPath.join(".") !== detector.member
  ) {
    return false;
  }
  if (
    detector.callArgumentIndex !== undefined &&
    (usage.argumentCount ?? 0) <= detector.callArgumentIndex
  ) {
    return false;
  }
  return true;
}

function confidenceFor(
  detector: MigrationChangeV1["detectors"][number],
): Confidence {
  if (detector.kind === "import" || detector.kind === "package_version") {
    return "certain";
  }
  if (detector.kind === "text_fallback") return "low";
  return detector.symbol || detector.member ? "high" : "medium";
}

function finding(input: {
  spec: MigrationSpecV1;
  change: MigrationChangeV1;
  file: RepositoryFile;
  start: number;
  end: number;
  detector: MigrationChangeV1["detectors"][number];
  suffix: string;
}): MigrationFinding {
  const precise =
    input.detector.kind !== "text_fallback" &&
    (input.detector.kind === "import" ||
      input.detector.kind === "package_version" ||
      Boolean(input.detector.symbol || input.detector.member));
  const patchEligible =
    input.change.autoPatchEligible &&
    input.change.transformation.kind !== "manual";
  return {
    id: `${input.change.id}:${input.file.path}:${input.start}:${input.suffix}`,
    ruleId: input.change.id,
    path: input.file.path,
    location: locationAt(input.file.content, input.start, input.end),
    excerpt: excerptAt(input.file.content, input.start, input.end),
    message: input.change.description,
    confidence: confidenceFor(input.detector),
    coverage: patchEligible && precise ? "full" : "partial",
    autoPatchEligible: patchEligible && precise,
    evidence: evidenceFor(input.spec, input.change.citations),
    metadata: {
      detectorKind: input.detector.kind,
      transformationKind: input.change.transformation.kind,
    },
  };
}

function genericFindings(input: {
  files: readonly RepositoryFile[];
  spec: MigrationSpecV1;
  index: RepositorySymbolIndex;
  dependency: MigrationAssessment["dependency"];
}): MigrationFinding[] {
  const files = new Map(input.files.map((file) => [file.path, file]));
  const output: MigrationFinding[] = [];
  for (const change of input.spec.changes) {
    for (const detector of change.detectors) {
      if (detector.kind === "package_version") {
        const manifest = input.dependency.manifestPath
          ? files.get(input.dependency.manifestPath)
          : undefined;
        if (
          manifest &&
          input.dependency.supportedSource &&
          !input.dependency.targetSatisfied
        ) {
          const start = Math.max(
            0,
            manifest.content.indexOf(input.spec.package.name),
          );
          output.push(
            finding({
              spec: input.spec,
              change,
              file: manifest,
              start,
              end: start + input.spec.package.name.length,
              detector,
              suffix: "dependency",
            }),
          );
        }
        continue;
      }

      if (detector.kind === "text_fallback") {
        if (!detector.textPattern) continue;
        for (const file of input.files) {
          if (!CODE_EXTENSION.test(file.path)) continue;
          let offset = 0;
          while (offset < file.content.length) {
            const start = file.content.indexOf(detector.textPattern, offset);
            if (start < 0) break;
            output.push(
              finding({
                spec: input.spec,
                change,
                file,
                start,
                end: start + detector.textPattern.length,
                detector,
                suffix: "text",
              }),
            );
            offset = start + Math.max(1, detector.textPattern.length);
          }
        }
        continue;
      }

      for (const indexed of input.index.files) {
        const file = files.get(indexed.path);
        if (!file) continue;
        if (detector.kind === "import") {
          for (const binding of indexed.bindings) {
            if (!bindingMatches(binding, detector)) continue;
            output.push(
              finding({
                spec: input.spec,
                change,
                file,
                start: binding.start,
                end: binding.end,
                detector,
                suffix: "import",
              }),
            );
          }
          continue;
        }
        for (const usage of indexed.usages) {
          const kindMatches =
            detector.kind === "constructor"
              ? (usage.kind === "call" || usage.kind === "new") &&
                usage.memberPath.length === 0
              : detector.kind === "call_expression"
                ? usage.kind === "call"
                : detector.kind === "symbol_reference";
          if (
            !kindMatches ||
            !usageMatches(usage, indexed.bindings, detector)
          ) {
            continue;
          }
          output.push(
            finding({
              spec: input.spec,
              change,
              file,
              start: usage.start,
              end: usage.end,
              detector,
              suffix: usage.kind,
            }),
          );
        }
      }
    }
  }
  return output;
}

function installedStripeFindings(input: {
  files: readonly RepositoryFile[];
  spec: MigrationSpecV1;
}): MigrationFinding[] {
  if (input.spec.package.name !== "stripe") return [];
  const changes = new Map(input.spec.changes.map((change) => [change.id, change]));
  return assessStripeV20ToV22(input.files).findings.flatMap((legacy) => {
    const change = changes.get(legacy.ruleId);
    if (!change) return [];
    return [
      {
        ...legacy,
        evidence: evidenceFor(input.spec, change.citations),
        metadata: {
          ...(legacy.metadata ?? {}),
          detectorKind: "installed_deterministic",
          transformationKind: change.transformation.kind,
        },
      },
    ];
  });
}

function deduplicate(findings: readonly MigrationFinding[]): MigrationFinding[] {
  const byCandidate = new Map<string, MigrationFinding>();
  for (const candidate of findings) {
    const key = `${candidate.ruleId}:${candidate.path}:${candidate.location.start}:${candidate.location.end}`;
    const existing = byCandidate.get(key);
    if (
      !existing ||
      (existing.confidence === "medium" && candidate.confidence === "high") ||
      (existing.confidence === "low" && candidate.confidence !== "low")
    ) {
      byCandidate.set(key, candidate);
    }
  }
  return [...byCandidate.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.location.start - right.location.start ||
      left.ruleId.localeCompare(right.ruleId),
  );
}

function skippedScope(
  files: readonly RepositoryFile[],
  index: RepositorySymbolIndex,
): Array<{ path: string; reason: string }> {
  const skipped = [...index.skipped];
  const indexed = new Set(index.files.map((file) => file.path));
  for (const file of files) {
    if (isDependencyMetadata(file.path)) continue;
    if (
      CODE_EXTENSION.test(file.path) &&
      (/\bimport\s*\(\s*[^"'`]/.test(file.content) ||
        /\brequire\s*\(\s*[^"'`]/.test(file.content))
    ) {
      skipped.push({
        path: file.path,
        reason: "Dynamic module resolution requires manual review.",
      });
    }
    if (indexed.has(file.path)) continue;
    if (!CODE_EXTENSION.test(file.path)) {
      skipped.push({
        path: file.path,
        reason: "Unsupported file type for the Node.js/TypeScript analyzer.",
      });
      continue;
    }
  }
  for (const file of index.files) {
    if (file.syntaxErrors > 0) {
      skipped.push({
        path: file.path,
        reason: `TypeScript reported ${file.syntaxErrors} syntax diagnostic(s); coverage is partial.`,
      });
    }
  }
  const unique = new Map(
    skipped.map((entry) => [`${entry.path}:${entry.reason}`, entry]),
  );
  return [...unique.values()].slice(0, 2_000);
}

export function assessMigrationSpec(input: {
  files: readonly RepositoryFile[];
  spec: MigrationSpecV1;
  symbolIndex?: RepositorySymbolIndex;
}): MigrationAssessment {
  const index = input.symbolIndex ?? buildRepositorySymbolIndex(input.files);
  const dependency = resolvePackageDependency({
    files: input.files,
    packageName: input.spec.package.name,
    sourceRange: input.spec.package.sourceRange,
    targetVersion: input.spec.package.targetVersion,
  });
  const findings = deduplicate([
    ...installedStripeFindings(input),
    ...genericFindings({
      files: input.files,
      spec: input.spec,
      index,
      dependency,
    }),
  ]);
  const skipped = skippedScope(input.files, index);
  const hasPartial =
    skipped.length > 0 ||
    findings.some(
      (candidate) =>
        candidate.coverage !== "full" || !candidate.autoPatchEligible,
    );
  return {
    specId: input.spec.id,
    specRevision: input.spec.revision,
    status:
      findings.length === 0
        ? skipped.length > 0
          ? "partial-coverage"
          : "no-impact"
        : hasPartial
          ? "partial-coverage"
          : "impact-found",
    dependency,
    findings,
    scannedFiles: index.files.map((file) => file.path),
    skipped,
  };
}

export const genericAnalyzerVersion = `spec-driven-analyzer/2.0.0 (${symbolIndexerVersion})`;
