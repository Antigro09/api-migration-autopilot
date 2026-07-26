import {
  finishValidation,
  isRecord,
  readArray,
  readBoolean,
  readEnum,
  readGitSha,
  readInteger,
  readIsoTimestamp,
  readNumber,
  readOptionalString,
  readSha256,
  readString,
} from "./validation";
import { VALIDATION_OUTCOMES, type ValidationOutcome } from "./states";

export const RUN_MANIFEST_SCHEMA_VERSION = "1" as const;
export const FINDING_CLASSIFICATIONS = [
  "affected",
  "not_affected",
  "uncertain",
  "unsupported",
] as const;
export type FindingClassification =
  (typeof FINDING_CLASSIFICATIONS)[number];

export interface RunFindingV1 {
  readonly id: string;
  readonly ruleId: string;
  readonly filePath: string;
  readonly fileSha256: string;
  readonly classification: FindingClassification;
  readonly confidence: number;
  readonly rationale: string;
  readonly citationArtifactIds: readonly string[];
}

export interface RunEditV1 {
  readonly id: string;
  readonly ruleId: string;
  readonly filePath: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly transformation:
    | "deterministic_codemod"
    | "parameterized_template"
    | "model_residual";
  readonly rationale: string;
  readonly citationArtifactIds: readonly string[];
}

export interface ValidationResultV1 {
  readonly id: string;
  readonly category: "install" | "lint" | "typecheck" | "build" | "test";
  readonly command: string;
  readonly outcome: ValidationOutcome;
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly logArtifactId?: string;
  readonly summary: string;
}

export interface RunManifestV1 {
  readonly schemaVersion: typeof RUN_MANIFEST_SCHEMA_VERSION;
  readonly runId: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly repositoryMigrationId: string;
  readonly campaignId: string;
  readonly migrationSpecId: string;
  readonly migrationSpecRevision: number;
  readonly baseSha: string;
  readonly versions: {
    readonly detector: string;
    readonly transformer: string;
    readonly prompt?: string;
    readonly model?: string;
    readonly sandboxImage: string;
  };
  readonly findings: readonly RunFindingV1[];
  readonly edits: readonly RunEditV1[];
  readonly allowedPaths: readonly string[];
  readonly patch: {
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly artifactId: string;
    readonly baseSha: string;
  };
  readonly integrity: {
    readonly allowedPathsPassed: boolean;
    readonly fileHashesPassed: boolean;
    readonly noBinaryChangesPassed: boolean;
    readonly noWorkflowChangesPassed: boolean;
    readonly patchSizePassed: boolean;
    readonly syntaxPassed: boolean;
    readonly baseShaPassed: boolean;
  };
  readonly validationResults: readonly ValidationResultV1[];
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
  readonly approval?: {
    readonly patchSha256: string;
    readonly approvedByMembershipId: string;
    readonly approvedAt: string;
  };
  readonly pullRequest?: {
    readonly provider: "github";
    readonly number: number;
    readonly url: string;
    readonly branch: string;
    readonly draft: true;
  };
  readonly cost: {
    readonly modelInputTokens: number;
    readonly modelOutputTokens: number;
    readonly modelCostUsd: number;
    readonly sandboxSeconds: number;
  };
  readonly audit: {
    readonly eventCount: number;
    readonly rootHash: string;
  };
  readonly timestamps: {
    readonly createdAt: string;
    readonly startedAt: string;
    readonly completedAt: string;
  };
  readonly cleanup: {
    readonly sourceDeletedAt?: string;
    readonly sandboxDestroyedAt?: string;
    readonly hardDeadlineAt: string;
    readonly complete: boolean;
  };
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const VALIDATION_CATEGORIES = [
  "install",
  "lint",
  "typecheck",
  "build",
  "test",
] as const;
const EDIT_TRANSFORMATIONS = [
  "deterministic_codemod",
  "parameterized_template",
  "model_residual",
] as const;

export function isSafeRepositoryPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > 1_024 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return !path.toLowerCase().startsWith(".github/workflows/");
}

function readRepositoryPath(
  value: unknown,
  path: string,
  issues: string[],
): string {
  const repositoryPath = readString(value, path, issues, { maxLength: 1_024 });
  if (repositoryPath && !isSafeRepositoryPath(repositoryPath)) {
    issues.push(
      `${path} must be a relative normalized path outside .github/workflows`,
    );
  }
  return repositoryPath;
}

function readId(value: unknown, path: string, issues: string[]): string {
  return readString(value, path, issues, {
    pattern: ID_PATTERN,
    maxLength: 128,
  });
}

function readIdList(
  value: unknown,
  path: string,
  issues: string[],
): string[] {
  return readArray(value, path, issues).map((entry, index) =>
    readId(entry, `${path}[${index}]`, issues),
  );
}

function readFinding(
  value: unknown,
  path: string,
  issues: string[],
): RunFindingV1 {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    value = {};
  }
  const record = value as Record<string, unknown>;
  return {
    id: readId(record.id, `${path}.id`, issues),
    ruleId: readId(record.ruleId, `${path}.ruleId`, issues),
    filePath: readRepositoryPath(record.filePath, `${path}.filePath`, issues),
    fileSha256: readSha256(
      record.fileSha256,
      `${path}.fileSha256`,
      issues,
    ),
    classification: readEnum(
      record.classification,
      FINDING_CLASSIFICATIONS,
      `${path}.classification`,
      issues,
    ),
    confidence: readNumber(record.confidence, `${path}.confidence`, issues, {
      min: 0,
      max: 1,
    }),
    rationale: readString(record.rationale, `${path}.rationale`, issues, {
      maxLength: 4_000,
    }),
    citationArtifactIds: readIdList(
      record.citationArtifactIds,
      `${path}.citationArtifactIds`,
      issues,
    ),
  };
}

function readEdit(
  value: unknown,
  path: string,
  issues: string[],
): RunEditV1 {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    value = {};
  }
  const record = value as Record<string, unknown>;
  return {
    id: readId(record.id, `${path}.id`, issues),
    ruleId: readId(record.ruleId, `${path}.ruleId`, issues),
    filePath: readRepositoryPath(record.filePath, `${path}.filePath`, issues),
    beforeSha256: readSha256(
      record.beforeSha256,
      `${path}.beforeSha256`,
      issues,
    ),
    afterSha256: readSha256(
      record.afterSha256,
      `${path}.afterSha256`,
      issues,
    ),
    transformation: readEnum(
      record.transformation,
      EDIT_TRANSFORMATIONS,
      `${path}.transformation`,
      issues,
    ),
    rationale: readString(record.rationale, `${path}.rationale`, issues, {
      maxLength: 4_000,
    }),
    citationArtifactIds: readIdList(
      record.citationArtifactIds,
      `${path}.citationArtifactIds`,
      issues,
    ),
  };
}

function readValidationResult(
  value: unknown,
  path: string,
  issues: string[],
): ValidationResultV1 {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    value = {};
  }
  const record = value as Record<string, unknown>;
  const outcome = readEnum(
    record.outcome,
    VALIDATION_OUTCOMES,
    `${path}.outcome`,
    issues,
  );
  const exitCode =
    record.exitCode === undefined
      ? undefined
      : readInteger(record.exitCode, `${path}.exitCode`, issues, {
          min: -1,
          max: 255,
        });
  if ((outcome === "passed" || outcome === "failed") && exitCode === undefined) {
    issues.push(`${path}.exitCode is required when a command ran`);
  }
  return {
    id: readId(record.id, `${path}.id`, issues),
    category: readEnum(
      record.category,
      VALIDATION_CATEGORIES,
      `${path}.category`,
      issues,
    ),
    command: readString(record.command, `${path}.command`, issues, {
      maxLength: 1_000,
    }),
    outcome,
    ...(exitCode === undefined ? {} : { exitCode }),
    durationMs: readInteger(
      record.durationMs,
      `${path}.durationMs`,
      issues,
      { min: 0, max: 86_400_000 },
    ),
    ...(record.logArtifactId === undefined
      ? {}
      : {
          logArtifactId: readId(
            record.logArtifactId,
            `${path}.logArtifactId`,
            issues,
          ),
        }),
    summary: readString(record.summary, `${path}.summary`, issues, {
      maxLength: 2_000,
    }),
  };
}

function readTimestampIfPresent(
  value: unknown,
  path: string,
  issues: string[],
): string | undefined {
  const timestamp = readOptionalString(value, path, issues);
  return timestamp ? readIsoTimestamp(timestamp, path, issues) : undefined;
}

function requireRecord(
  value: unknown,
  path: string,
  issues: string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return {};
  }
  return value;
}

export function parseRunManifestV1(value: unknown): RunManifestV1 {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return finishValidation(["RunManifestV1 must be an object"], null as never);
  }

  const versions = requireRecord(value.versions, "RunManifestV1.versions", issues);
  const patch = requireRecord(value.patch, "RunManifestV1.patch", issues);
  const integrity = requireRecord(
    value.integrity,
    "RunManifestV1.integrity",
    issues,
  );
  const executionPolicy = requireRecord(
    value.executionPolicy,
    "RunManifestV1.executionPolicy",
    issues,
  );
  const cost = requireRecord(value.cost, "RunManifestV1.cost", issues);
  const audit = requireRecord(value.audit, "RunManifestV1.audit", issues);
  const timestamps = requireRecord(
    value.timestamps,
    "RunManifestV1.timestamps",
    issues,
  );
  const cleanup = requireRecord(value.cleanup, "RunManifestV1.cleanup", issues);

  const findings = readArray(
    value.findings,
    "RunManifestV1.findings",
    issues,
  ).map((finding, index) =>
    readFinding(finding, `RunManifestV1.findings[${index}]`, issues),
  );
  const edits = readArray(value.edits, "RunManifestV1.edits", issues).map(
    (edit, index) => readEdit(edit, `RunManifestV1.edits[${index}]`, issues),
  );
  const allowedPaths = readArray(
    value.allowedPaths,
    "RunManifestV1.allowedPaths",
    issues,
  ).map((entry, index) =>
    readRepositoryPath(
      entry,
      `RunManifestV1.allowedPaths[${index}]`,
      issues,
    ),
  );
  const uniqueAllowedPaths = new Set(allowedPaths);
  if (uniqueAllowedPaths.size !== allowedPaths.length) {
    issues.push("RunManifestV1.allowedPaths cannot contain duplicates");
  }
  for (const [index, edit] of edits.entries()) {
    if (!uniqueAllowedPaths.has(edit.filePath)) {
      issues.push(
        `RunManifestV1.edits[${index}].filePath is not in allowedPaths`,
      );
    }
  }

  const patchSha256 = readSha256(
    patch.sha256,
    "RunManifestV1.patch.sha256",
    issues,
  );
  const baseSha = readGitSha(value.baseSha, "RunManifestV1.baseSha", issues);
  const patchBaseSha = readGitSha(
    patch.baseSha,
    "RunManifestV1.patch.baseSha",
    issues,
  );
  if (baseSha && patchBaseSha && baseSha !== patchBaseSha) {
    issues.push("RunManifestV1.patch.baseSha must equal baseSha");
  }

  let approval: RunManifestV1["approval"];
  if (value.approval !== undefined) {
    const approvalRecord = requireRecord(
      value.approval,
      "RunManifestV1.approval",
      issues,
    );
    const approvedPatchSha = readSha256(
      approvalRecord.patchSha256,
      "RunManifestV1.approval.patchSha256",
      issues,
    );
    if (approvedPatchSha && patchSha256 && approvedPatchSha !== patchSha256) {
      issues.push(
        "RunManifestV1.approval.patchSha256 must equal patch.sha256",
      );
    }
    approval = {
      patchSha256: approvedPatchSha,
      approvedByMembershipId: readId(
        approvalRecord.approvedByMembershipId,
        "RunManifestV1.approval.approvedByMembershipId",
        issues,
      ),
      approvedAt: readIsoTimestamp(
        approvalRecord.approvedAt,
        "RunManifestV1.approval.approvedAt",
        issues,
      ),
    };
  }

  let pullRequest: RunManifestV1["pullRequest"];
  if (value.pullRequest !== undefined) {
    const pullRequestRecord = requireRecord(
      value.pullRequest,
      "RunManifestV1.pullRequest",
      issues,
    );
    if (!approval) {
      issues.push("RunManifestV1.pullRequest requires patch approval");
    }
    const url = readString(
      pullRequestRecord.url,
      "RunManifestV1.pullRequest.url",
      issues,
      { maxLength: 2_048 },
    );
    if (url) {
      try {
        if (new URL(url).protocol !== "https:") {
          issues.push("RunManifestV1.pullRequest.url must use https");
        }
      } catch {
        issues.push("RunManifestV1.pullRequest.url must be an absolute URL");
      }
    }
    const draft = readBoolean(
      pullRequestRecord.draft,
      "RunManifestV1.pullRequest.draft",
      issues,
    );
    if (!draft) {
      issues.push("RunManifestV1.pullRequest.draft must be true");
    }
    pullRequest = {
      provider: readEnum(
        pullRequestRecord.provider,
        ["github"] as const,
        "RunManifestV1.pullRequest.provider",
        issues,
      ),
      number: readInteger(
        pullRequestRecord.number,
        "RunManifestV1.pullRequest.number",
        issues,
        { min: 1 },
      ),
      url,
      branch: readString(
        pullRequestRecord.branch,
        "RunManifestV1.pullRequest.branch",
        issues,
        { pattern: /^migration-autopilot\/[a-zA-Z0-9._/-]+$/, maxLength: 255 },
      ),
      draft: true,
    };
  }

  const network = readEnum(
    executionPolicy.network,
    ["none", "registry_only"] as const,
    "RunManifestV1.executionPolicy.network",
    issues,
  );
  const allowedHosts = readArray(
    executionPolicy.allowedHosts,
    "RunManifestV1.executionPolicy.allowedHosts",
    issues,
  ).map((entry, index) =>
    readString(
      entry,
      `RunManifestV1.executionPolicy.allowedHosts[${index}]`,
      issues,
      {
        pattern:
          /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,62}$/i,
        maxLength: 253,
      },
    ),
  );
  if (network === "none" && allowedHosts.length > 0) {
    issues.push(
      "RunManifestV1.executionPolicy.allowedHosts must be empty when network is none",
    );
  }

  const sourceDeletedAt = readTimestampIfPresent(
    cleanup.sourceDeletedAt,
    "RunManifestV1.cleanup.sourceDeletedAt",
    issues,
  );
  const sandboxDestroyedAt = readTimestampIfPresent(
    cleanup.sandboxDestroyedAt,
    "RunManifestV1.cleanup.sandboxDestroyedAt",
    issues,
  );
  const cleanupComplete = readBoolean(
    cleanup.complete,
    "RunManifestV1.cleanup.complete",
    issues,
  );
  if (cleanupComplete && (!sourceDeletedAt || !sandboxDestroyedAt)) {
    issues.push(
      "RunManifestV1.cleanup.complete requires source and sandbox deletion timestamps",
    );
  }

  const result: RunManifestV1 = {
    schemaVersion: readEnum(
      value.schemaVersion,
      [RUN_MANIFEST_SCHEMA_VERSION] as const,
      "RunManifestV1.schemaVersion",
      issues,
    ),
    runId: readId(value.runId, "RunManifestV1.runId", issues),
    organizationId: readId(
      value.organizationId,
      "RunManifestV1.organizationId",
      issues,
    ),
    repositoryId: readId(
      value.repositoryId,
      "RunManifestV1.repositoryId",
      issues,
    ),
    repositoryMigrationId: readId(
      value.repositoryMigrationId,
      "RunManifestV1.repositoryMigrationId",
      issues,
    ),
    campaignId: readId(
      value.campaignId,
      "RunManifestV1.campaignId",
      issues,
    ),
    migrationSpecId: readId(
      value.migrationSpecId,
      "RunManifestV1.migrationSpecId",
      issues,
    ),
    migrationSpecRevision: readInteger(
      value.migrationSpecRevision,
      "RunManifestV1.migrationSpecRevision",
      issues,
      { min: 1 },
    ),
    baseSha,
    versions: {
      detector: readString(
        versions.detector,
        "RunManifestV1.versions.detector",
        issues,
        { maxLength: 128 },
      ),
      transformer: readString(
        versions.transformer,
        "RunManifestV1.versions.transformer",
        issues,
        { maxLength: 128 },
      ),
      ...(versions.prompt === undefined
        ? {}
        : {
            prompt: readString(
              versions.prompt,
              "RunManifestV1.versions.prompt",
              issues,
              { maxLength: 128 },
            ),
          }),
      ...(versions.model === undefined
        ? {}
        : {
            model: readString(
              versions.model,
              "RunManifestV1.versions.model",
              issues,
              { maxLength: 128 },
            ),
          }),
      sandboxImage: readString(
        versions.sandboxImage,
        "RunManifestV1.versions.sandboxImage",
        issues,
        { maxLength: 256 },
      ),
    },
    findings,
    edits,
    allowedPaths,
    patch: {
      sha256: patchSha256,
      sizeBytes: readInteger(
        patch.sizeBytes,
        "RunManifestV1.patch.sizeBytes",
        issues,
        { min: 1, max: 10_000_000 },
      ),
      artifactId: readId(
        patch.artifactId,
        "RunManifestV1.patch.artifactId",
        issues,
      ),
      baseSha: patchBaseSha,
    },
    integrity: {
      allowedPathsPassed: readBoolean(
        integrity.allowedPathsPassed,
        "RunManifestV1.integrity.allowedPathsPassed",
        issues,
      ),
      fileHashesPassed: readBoolean(
        integrity.fileHashesPassed,
        "RunManifestV1.integrity.fileHashesPassed",
        issues,
      ),
      noBinaryChangesPassed: readBoolean(
        integrity.noBinaryChangesPassed,
        "RunManifestV1.integrity.noBinaryChangesPassed",
        issues,
      ),
      noWorkflowChangesPassed: readBoolean(
        integrity.noWorkflowChangesPassed,
        "RunManifestV1.integrity.noWorkflowChangesPassed",
        issues,
      ),
      patchSizePassed: readBoolean(
        integrity.patchSizePassed,
        "RunManifestV1.integrity.patchSizePassed",
        issues,
      ),
      syntaxPassed: readBoolean(
        integrity.syntaxPassed,
        "RunManifestV1.integrity.syntaxPassed",
        issues,
      ),
      baseShaPassed: readBoolean(
        integrity.baseShaPassed,
        "RunManifestV1.integrity.baseShaPassed",
        issues,
      ),
    },
    validationResults: readArray(
      value.validationResults,
      "RunManifestV1.validationResults",
      issues,
    ).map((validation, index) =>
      readValidationResult(
        validation,
        `RunManifestV1.validationResults[${index}]`,
        issues,
      ),
    ),
    executionPolicy: {
      network,
      allowedHosts,
      cpuCount: readInteger(
        executionPolicy.cpuCount,
        "RunManifestV1.executionPolicy.cpuCount",
        issues,
        { min: 1, max: 16 },
      ),
      memoryMiB: readInteger(
        executionPolicy.memoryMiB,
        "RunManifestV1.executionPolicy.memoryMiB",
        issues,
        { min: 256, max: 32_768 },
      ),
      diskMiB: readInteger(
        executionPolicy.diskMiB,
        "RunManifestV1.executionPolicy.diskMiB",
        issues,
        { min: 256, max: 102_400 },
      ),
      maxProcesses: readInteger(
        executionPolicy.maxProcesses,
        "RunManifestV1.executionPolicy.maxProcesses",
        issues,
        { min: 1, max: 1_024 },
      ),
      maxOutputBytes: readInteger(
        executionPolicy.maxOutputBytes,
        "RunManifestV1.executionPolicy.maxOutputBytes",
        issues,
        { min: 1_024, max: 100_000_000 },
      ),
      timeoutSeconds: readInteger(
        executionPolicy.timeoutSeconds,
        "RunManifestV1.executionPolicy.timeoutSeconds",
        issues,
        { min: 1, max: 1_200 },
      ),
    },
    ...(approval ? { approval } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    cost: {
      modelInputTokens: readInteger(
        cost.modelInputTokens,
        "RunManifestV1.cost.modelInputTokens",
        issues,
        { min: 0 },
      ),
      modelOutputTokens: readInteger(
        cost.modelOutputTokens,
        "RunManifestV1.cost.modelOutputTokens",
        issues,
        { min: 0 },
      ),
      modelCostUsd: readNumber(
        cost.modelCostUsd,
        "RunManifestV1.cost.modelCostUsd",
        issues,
        { min: 0 },
      ),
      sandboxSeconds: readInteger(
        cost.sandboxSeconds,
        "RunManifestV1.cost.sandboxSeconds",
        issues,
        { min: 0 },
      ),
    },
    audit: {
      eventCount: readInteger(
        audit.eventCount,
        "RunManifestV1.audit.eventCount",
        issues,
        { min: 1 },
      ),
      rootHash: readSha256(
        audit.rootHash,
        "RunManifestV1.audit.rootHash",
        issues,
      ),
    },
    timestamps: {
      createdAt: readIsoTimestamp(
        timestamps.createdAt,
        "RunManifestV1.timestamps.createdAt",
        issues,
      ),
      startedAt: readIsoTimestamp(
        timestamps.startedAt,
        "RunManifestV1.timestamps.startedAt",
        issues,
      ),
      completedAt: readIsoTimestamp(
        timestamps.completedAt,
        "RunManifestV1.timestamps.completedAt",
        issues,
      ),
    },
    cleanup: {
      ...(sourceDeletedAt ? { sourceDeletedAt } : {}),
      ...(sandboxDestroyedAt ? { sandboxDestroyedAt } : {}),
      hardDeadlineAt: readIsoTimestamp(
        cleanup.hardDeadlineAt,
        "RunManifestV1.cleanup.hardDeadlineAt",
        issues,
      ),
      complete: cleanupComplete,
    },
  };

  const integrityPassed = Object.values(result.integrity).every(Boolean);
  if ((result.approval || result.pullRequest) && !integrityPassed) {
    issues.push(
      "Patch approval and PR publication require every integrity check to pass",
    );
  }
  if (
    Date.parse(result.timestamps.startedAt) <
      Date.parse(result.timestamps.createdAt) ||
    Date.parse(result.timestamps.completedAt) <
      Date.parse(result.timestamps.startedAt)
  ) {
    issues.push("RunManifestV1 timestamps must be chronological");
  }
  if (
    Date.parse(result.cleanup.hardDeadlineAt) >
    Date.parse(result.timestamps.completedAt) + 24 * 60 * 60 * 1_000
  ) {
    issues.push(
      "RunManifestV1.cleanup.hardDeadlineAt cannot exceed 24 hours after completion",
    );
  }

  return finishValidation(issues, result);
}

export function isRunManifestV1(value: unknown): value is RunManifestV1 {
  try {
    parseRunManifestV1(value);
    return true;
  } catch {
    return false;
  }
}
