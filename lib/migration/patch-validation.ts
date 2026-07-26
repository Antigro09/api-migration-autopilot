import { DomainError } from "@/lib/domain/errors";
import type { JsonValue } from "@/lib/domain";
import type { FileEdit } from "./contracts";
import {
  boolean,
  gitObjectId,
  integer,
  list,
  oneOf,
  record,
  repositoryPath,
  sha256Hex,
  text,
} from "./parsing";

export const VALIDATION_CATEGORIES = [
  "install",
  "lint",
  "typecheck",
  "build",
  "test",
] as const;
export type ValidationCategory = (typeof VALIDATION_CATEGORIES)[number];

export type PatchIntegrityIssue = {
  readonly code: string;
  readonly path?: string;
  readonly message: string;
};

export type ValidationLog = {
  readonly category: ValidationCategory;
  readonly command: string;
  readonly output: string;
  readonly truncated: boolean;
};

export type WorkerValidationResult = {
  readonly category: ValidationCategory;
  readonly command: string;
  readonly outcome: "passed" | "failed" | "incomplete" | "not_run";
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly summary: string;
};

export type PatchIntegrityReport = {
  readonly allowedPathsPassed: boolean;
  readonly fileHashesPassed: boolean;
  readonly noBinaryChangesPassed: boolean;
  readonly noWorkflowChangesPassed: boolean;
  readonly patchSizePassed: boolean;
  readonly syntaxPassed: boolean;
  readonly baseShaPassed: boolean;
};

export interface PatchRunResult {
  readonly specId: string;
  readonly specRevision: number;
  readonly baseSha: string;
  readonly patchSha256: string;
  readonly files: readonly FileEdit[];
  /** Manifest-native findings and edits; validated again by parseRunManifestV1. */
  readonly findings: readonly JsonValue[];
  readonly edits: readonly JsonValue[];
  readonly unresolvedFindingIds: readonly string[];
  readonly integrity: PatchIntegrityReport;
  readonly workerIssues: readonly PatchIntegrityIssue[];
  readonly validation: readonly WorkerValidationResult[];
  readonly validationLogs: readonly ValidationLog[];
  readonly versions: {
    readonly detector: string;
    readonly transformer: string;
    readonly prompt?: string;
    readonly model?: string;
    readonly sandboxImage: string;
  };
  readonly executionPolicy: {
    readonly network: "none" | "registry_only";
    readonly allowedHosts: readonly string[];
    readonly cpuCount: number;
    readonly memoryMiB: number;
    readonly diskMiB: number;
    readonly maxProcesses: number;
    readonly maxOutputBytes: number;
    readonly timeoutSeconds: number;
  };
  readonly cost: {
    readonly modelInputTokens: number;
    readonly modelOutputTokens: number;
    readonly modelCostUsd: number;
    readonly sandboxSeconds: number;
  };
  readonly cleanup: {
    readonly sourceDeletedAt?: string;
    readonly sandboxDestroyedAt?: string;
    readonly complete: boolean;
  };
}

const MAX_FILE_CONTENT_BYTES = 1024 * 1024;
const MAX_LOG_BYTES = 256 * 1024;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function fileContent(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", `${label} must be a string.`);
  }
  if (byteLength(value) > MAX_FILE_CONTENT_BYTES) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${label} exceeds the 1 MiB per-file limit.`,
    );
  }
  if (value.includes("\0")) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${label} contains binary content.`,
    );
  }
  return value;
}

function fileEdit(value: unknown, index: number): FileEdit {
  const input = record(value, `patch.files[${index}]`);
  return {
    path: repositoryPath(input.path, `patch.files[${index}].path`),
    originalContent: fileContent(
      input.originalContent,
      `patch.files[${index}].originalContent`,
    ),
    newContent: fileContent(
      input.newContent,
      `patch.files[${index}].newContent`,
    ),
    ruleIds: list(input.ruleIds, `patch.files[${index}].ruleIds`, 50).map(
      (rule) => text(rule, "patch.files[].ruleIds[]", 256) as string,
    ),
    rationale: list(
      input.rationale,
      `patch.files[${index}].rationale`,
      50,
    ).map((entry) => text(entry, "patch.files[].rationale[]", 2_000) as string),
  };
}

function integrityIssue(value: unknown, index: number): PatchIntegrityIssue {
  const input = record(value, `patch.workerIssues[${index}]`);
  return {
    code: text(input.code, "workerIssue.code", 128) as string,
    ...(input.path === undefined
      ? {}
      : { path: text(input.path, "workerIssue.path", 1_024) as string }),
    message: text(input.message, "workerIssue.message", 1_000) as string,
  };
}

function validationResult(
  value: unknown,
  index: number,
): WorkerValidationResult {
  const input = record(value, `patch.validation[${index}]`);
  const outcome = oneOf(input.outcome, "validation.outcome", [
    "passed",
    "failed",
    "incomplete",
    "not_run",
  ] as const);
  const exitCode =
    input.exitCode === undefined
      ? undefined
      : integer(input.exitCode, "validation.exitCode", -1, 255);
  if ((outcome === "passed" || outcome === "failed") && exitCode === undefined) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "A validation command that ran must report an exit code.",
    );
  }
  return {
    category: oneOf(
      input.category,
      "validation.category",
      VALIDATION_CATEGORIES,
    ),
    command: text(input.command, "validation.command", 500) as string,
    outcome,
    ...(exitCode === undefined ? {} : { exitCode }),
    durationMs: integer(
      input.durationMs,
      "validation.durationMs",
      0,
      86_400_000,
    ),
    summary: text(input.summary, "validation.summary", 2_000) as string,
  };
}

function validationLog(value: unknown, index: number): ValidationLog {
  const input = record(value, `patch.validationLogs[${index}]`);
  const output = typeof input.output === "string" ? input.output : "";
  if (byteLength(output) > MAX_LOG_BYTES) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `patch.validationLogs[${index}].output exceeds the 256 KiB limit.`,
    );
  }
  return {
    category: oneOf(input.category, "log.category", VALIDATION_CATEGORIES),
    command: text(input.command, "log.command", 500) as string,
    output,
    truncated: boolean(input.truncated, "log.truncated"),
  };
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label, 64) as string;
  if (!ISO_TIMESTAMP.test(parsed) || Number.isNaN(Date.parse(parsed))) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${label} must be an ISO-8601 UTC timestamp.`,
    );
  }
  return parsed;
}

/**
 * Bounded structural parse of a worker patch result. Findings and edits are
 * carried through as JSON and validated a second time by parseRunManifestV1,
 * so a malformed worker can never persist a manifest.
 */
export function parsePatchRunResult(value: unknown): PatchRunResult {
  const input = record(value, "patch");
  const versions = record(input.versions, "patch.versions");
  const integrity = record(input.integrity, "patch.integrity");
  const executionPolicy = record(input.executionPolicy, "patch.executionPolicy");
  const cost = record(input.cost, "patch.cost");
  const cleanup = record(input.cleanup, "patch.cleanup");

  return {
    specId: text(input.specId, "patch.specId", 256) as string,
    specRevision: integer(input.specRevision, "patch.specRevision", 1, 1_000_000),
    baseSha: gitObjectId(input.baseSha, "patch.baseSha"),
    patchSha256: sha256Hex(input.patchSha256, "patch.patchSha256"),
    files: list(input.files, "patch.files", 100).map(fileEdit),
    findings: list(input.findings, "patch.findings", 10_000) as JsonValue[],
    edits: list(input.edits, "patch.edits", 2_000) as JsonValue[],
    unresolvedFindingIds: list(
      input.unresolvedFindingIds,
      "patch.unresolvedFindingIds",
      10_000,
    ).map((entry) => text(entry, "patch.unresolvedFindingIds[]", 128) as string),
    integrity: {
      allowedPathsPassed: boolean(
        integrity.allowedPathsPassed,
        "integrity.allowedPathsPassed",
      ),
      fileHashesPassed: boolean(
        integrity.fileHashesPassed,
        "integrity.fileHashesPassed",
      ),
      noBinaryChangesPassed: boolean(
        integrity.noBinaryChangesPassed,
        "integrity.noBinaryChangesPassed",
      ),
      noWorkflowChangesPassed: boolean(
        integrity.noWorkflowChangesPassed,
        "integrity.noWorkflowChangesPassed",
      ),
      patchSizePassed: boolean(
        integrity.patchSizePassed,
        "integrity.patchSizePassed",
      ),
      syntaxPassed: boolean(integrity.syntaxPassed, "integrity.syntaxPassed"),
      baseShaPassed: boolean(integrity.baseShaPassed, "integrity.baseShaPassed"),
    },
    workerIssues: list(input.workerIssues, "patch.workerIssues", 500).map(
      integrityIssue,
    ),
    validation: list(input.validation, "patch.validation", 16).map(
      validationResult,
    ),
    validationLogs: list(input.validationLogs, "patch.validationLogs", 16).map(
      validationLog,
    ),
    versions: {
      detector: text(versions.detector, "versions.detector", 128) as string,
      transformer: text(versions.transformer, "versions.transformer", 128) as string,
      ...(versions.prompt === undefined
        ? {}
        : { prompt: text(versions.prompt, "versions.prompt", 128) as string }),
      ...(versions.model === undefined
        ? {}
        : { model: text(versions.model, "versions.model", 128) as string }),
      sandboxImage: text(
        versions.sandboxImage,
        "versions.sandboxImage",
        128,
      ) as string,
    },
    executionPolicy: {
      network: oneOf(executionPolicy.network, "executionPolicy.network", [
        "none",
        "registry_only",
      ] as const),
      allowedHosts: list(
        executionPolicy.allowedHosts,
        "executionPolicy.allowedHosts",
        50,
      ).map((host) => text(host, "executionPolicy.allowedHosts[]", 256) as string),
      cpuCount: integer(executionPolicy.cpuCount, "executionPolicy.cpuCount", 0, 128),
      memoryMiB: integer(
        executionPolicy.memoryMiB,
        "executionPolicy.memoryMiB",
        0,
        1_048_576,
      ),
      diskMiB: integer(
        executionPolicy.diskMiB,
        "executionPolicy.diskMiB",
        0,
        10_485_760,
      ),
      maxProcesses: integer(
        executionPolicy.maxProcesses,
        "executionPolicy.maxProcesses",
        0,
        100_000,
      ),
      maxOutputBytes: integer(
        executionPolicy.maxOutputBytes,
        "executionPolicy.maxOutputBytes",
        0,
        67_108_864,
      ),
      timeoutSeconds: integer(
        executionPolicy.timeoutSeconds,
        "executionPolicy.timeoutSeconds",
        0,
        86_400,
      ),
    },
    cost: {
      modelInputTokens: integer(
        cost.modelInputTokens,
        "cost.modelInputTokens",
        0,
        100_000_000,
      ),
      modelOutputTokens: integer(
        cost.modelOutputTokens,
        "cost.modelOutputTokens",
        0,
        100_000_000,
      ),
      modelCostUsd: (() => {
        const value = cost.modelCostUsd;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new DomainError(
            "VALIDATION_FAILED",
            "cost.modelCostUsd must be a non-negative finite number.",
          );
        }
        return value;
      })(),
      sandboxSeconds: integer(
        cost.sandboxSeconds,
        "cost.sandboxSeconds",
        0,
        86_400,
      ),
    },
    cleanup: {
      ...(cleanup.sourceDeletedAt === undefined
        ? {}
        : {
            sourceDeletedAt: timestamp(
              cleanup.sourceDeletedAt,
              "cleanup.sourceDeletedAt",
            ),
          }),
      ...(cleanup.sandboxDestroyedAt === undefined
        ? {}
        : {
            sandboxDestroyedAt: timestamp(
              cleanup.sandboxDestroyedAt,
              "cleanup.sandboxDestroyedAt",
            ),
          }),
      complete: boolean(cleanup.complete, "cleanup.complete"),
    },
  };
}
