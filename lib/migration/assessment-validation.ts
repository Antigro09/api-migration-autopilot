import { DomainError } from "@/lib/domain/errors";
import type {
  Confidence,
  Coverage,
  MigrationAssessment,
  MigrationFinding,
  SourceCitation,
} from "./contracts";
import {
  boolean,
  integer,
  list,
  oneOf,
  record,
  repositoryPath,
  text,
} from "./parsing";

function citation(value: unknown, index: number): SourceCitation {
  const input = record(value, `findings[].evidence[${index}]`);
  const rawUrl = text(input.url, "citation.url", 2_048) as string;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DomainError("VALIDATION_FAILED", "Citation URL is invalid.");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Citation URL must be an HTTP(S) URL without credentials.",
    );
  }
  return {
    title: text(input.title, "citation.title", 500) as string,
    url: url.toString(),
  };
}

export function parseMigrationFinding(
  value: unknown,
  index: number,
): MigrationFinding {
  const input = record(value, `findings[${index}]`);
  const location = record(input.location, `findings[${index}].location`);
  const evidence = list(input.evidence, "finding.evidence", 20).map(citation);
  const metadataInput =
    input.metadata === undefined ? undefined : record(input.metadata, "finding.metadata");
  const metadata: Record<string, string | number | boolean> = {};
  if (metadataInput) {
    const entries = Object.entries(metadataInput);
    if (entries.length > 50) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Finding metadata contains too many entries.",
      );
    }
    for (const [key, entry] of entries) {
      if (
        key.length === 0 ||
        key.length > 100 ||
        !["string", "number", "boolean"].includes(typeof entry)
      ) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "Finding metadata contains an unsupported entry.",
        );
      }
      metadata[key] = entry as string | number | boolean;
    }
  }
  return {
    id: text(input.id, "finding.id", 2_048) as string,
    ruleId: text(input.ruleId, "finding.ruleId", 256) as string,
    path: repositoryPath(input.path, "finding.path"),
    location: {
      start: integer(location.start, "finding.location.start", 0, 100_000_000),
      end: integer(location.end, "finding.location.end", 0, 100_000_000),
      line: integer(location.line, "finding.location.line", 1, 10_000_000),
      column: integer(location.column, "finding.location.column", 1, 10_000_000),
    },
    // Source excerpts are intentionally discarded at this boundary. The
    // assessment record retains evidence and location, not repository source.
    excerpt: "",
    message: text(input.message, "finding.message", 2_000) as string,
    confidence: oneOf<Confidence>(
      input.confidence,
      "finding.confidence",
      ["certain", "high", "medium", "low"],
    ),
    coverage: oneOf<Coverage>(
      input.coverage,
      "finding.coverage",
      ["full", "partial", "unsupported"],
    ),
    autoPatchEligible: boolean(
      input.autoPatchEligible,
      "finding.autoPatchEligible",
    ),
    evidence,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export function parseMigrationAssessment(value: unknown): MigrationAssessment {
  const input = record(value, "assessment");
  const dependency = record(input.dependency, "assessment.dependency");
  const optionalText = (entry: unknown, label: string, maximum: number) =>
    text(entry, label, maximum, true);
  return {
    specId: text(input.specId, "assessment.specId", 256) as string,
    specRevision: integer(
      input.specRevision,
      "assessment.specRevision",
      1,
      1_000_000,
    ),
    status: oneOf(
      input.status,
      "assessment.status",
      ["no-impact", "impact-found", "partial-coverage"] as const,
    ),
    dependency: {
      packageName: text(
        dependency.packageName,
        "dependency.packageName",
        256,
      ) as string,
      ...(optionalText(dependency.declaredRange, "dependency.declaredRange", 256)
        ? {
            declaredRange: optionalText(
              dependency.declaredRange,
              "dependency.declaredRange",
              256,
            ),
          }
        : {}),
      ...(optionalText(
        dependency.resolvedVersion,
        "dependency.resolvedVersion",
        256,
      )
        ? {
            resolvedVersion: optionalText(
              dependency.resolvedVersion,
              "dependency.resolvedVersion",
              256,
            ),
          }
        : {}),
      ...(dependency.manifestPath === undefined
        ? {}
        : {
            manifestPath: repositoryPath(
              dependency.manifestPath,
              "dependency.manifestPath",
            ),
          }),
      ...(dependency.lockfilePath === undefined
        ? {}
        : {
            lockfilePath: repositoryPath(
              dependency.lockfilePath,
              "dependency.lockfilePath",
            ),
          }),
      supportedSource: boolean(
        dependency.supportedSource,
        "dependency.supportedSource",
      ),
      targetSatisfied: boolean(
        dependency.targetSatisfied,
        "dependency.targetSatisfied",
      ),
      warnings: list(dependency.warnings, "dependency.warnings", 100).map(
        (warning) => text(warning, "dependency.warning", 1_000) as string,
      ),
    },
    findings: list(input.findings, "assessment.findings", 10_000).map(
      parseMigrationFinding,
    ),
    scannedFiles: list(
      input.scannedFiles,
      "assessment.scannedFiles",
      2_000,
    ).map((path) => repositoryPath(path, "assessment.scannedFiles[]")),
    skipped: list(input.skipped, "assessment.skipped", 2_000).map(
      (value, index) => {
        const skipped = record(value, `assessment.skipped[${index}]`);
        const path =
          skipped.path === "[repository]"
            ? "[repository]"
            : repositoryPath(skipped.path, "assessment.skipped[].path");
        return {
          path,
          reason: text(
            skipped.reason,
            "assessment.skipped[].reason",
            1_000,
          ) as string,
        };
      },
    ),
  };
}
