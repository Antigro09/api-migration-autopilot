export const MIGRATION_SPEC_VERSION = "1" as const;
export const RUN_MANIFEST_VERSION = "1" as const;

export type Severity = "info" | "warning" | "error";
export type Confidence = "certain" | "high" | "medium" | "low";
export type Coverage = "full" | "partial" | "unsupported";

export interface SourceCitation {
  readonly title: string;
  readonly url?: string;
  readonly excerpt?: string;
}

export type DetectorConfiguration =
  | {
      readonly kind: "dependency-version";
      readonly packageName: string;
      readonly supportedRange: string;
    }
  | {
      readonly kind: "syntax-pattern";
      readonly description: string;
      readonly fileExtensions: readonly string[];
      readonly patternIds: readonly string[];
    };

export type TransformationConfiguration =
  | {
      readonly kind: "deterministic";
      readonly transformerId: string;
    }
  | {
      readonly kind: "template";
      readonly transformerId: string;
      readonly parameters: readonly string[];
    }
  | {
      readonly kind: "model-assisted";
      readonly reason: string;
    }
  | {
      readonly kind: "manual";
      readonly reason: string;
    };

export interface MigrationChangeV1 {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly severity: Severity;
  readonly citations: readonly SourceCitation[];
  readonly detector: DetectorConfiguration;
  readonly transformation: TransformationConfiguration;
  readonly behavioralInvariants: readonly string[];
  readonly validationHints: readonly string[];
  readonly autoPatchEligible: boolean;
  readonly knownLimitations: readonly string[];
}

export interface MigrationSpecV1 {
  readonly schemaVersion: typeof MIGRATION_SPEC_VERSION;
  readonly id: string;
  readonly revision: number;
  readonly campaignKind: "provider-sponsored" | "independent-reference";
  readonly provider: {
    readonly id: string;
    readonly displayName: string;
    readonly verifiedSponsor: boolean;
  };
  readonly product: {
    readonly id: string;
    readonly displayName: string;
  };
  readonly ecosystem: "node";
  readonly language: "typescript-javascript";
  readonly packageName: string;
  readonly sourceRange: string;
  readonly targetVersion: string;
  readonly pinnedApiVersion?: string;
  readonly minimumRuntime?: {
    readonly name: "node";
    readonly version: string;
  };
  readonly sourceArtifacts: readonly {
    readonly id: string;
    readonly title: string;
    readonly url: string;
    readonly sha256?: string;
  }[];
  readonly changes: readonly MigrationChangeV1[];
  readonly approvedAt?: string;
  readonly approvedBy?: string;
}

export interface RepositoryFile {
  readonly path: string;
  readonly content: string;
}

export interface SourceLocation {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface MigrationFinding {
  readonly id: string;
  readonly ruleId: string;
  readonly path: string;
  readonly location: SourceLocation;
  readonly excerpt: string;
  readonly message: string;
  readonly confidence: Confidence;
  readonly coverage: Coverage;
  readonly autoPatchEligible: boolean;
  readonly evidence: readonly SourceCitation[];
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface DependencyResolution {
  readonly packageName: string;
  readonly declaredRange?: string;
  readonly resolvedVersion?: string;
  readonly manifestPath?: string;
  readonly lockfilePath?: string;
  readonly supportedSource: boolean;
  readonly targetSatisfied: boolean;
  readonly warnings: readonly string[];
}

export interface MigrationAssessment {
  readonly specId: string;
  readonly specRevision: number;
  readonly status: "no-impact" | "impact-found" | "partial-coverage";
  readonly dependency: DependencyResolution;
  readonly findings: readonly MigrationFinding[];
  readonly scannedFiles: readonly string[];
  readonly skipped: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
}

export interface FileEdit {
  readonly path: string;
  readonly originalContent: string;
  readonly newContent: string;
  readonly ruleIds: readonly string[];
  readonly rationale: readonly string[];
}

export interface ProposedPatch {
  readonly specId: string;
  readonly specRevision: number;
  readonly baseSha: string;
  readonly files: readonly FileEdit[];
  readonly patchSha256: string;
}

export interface ValidationCommandResult {
  readonly command: string;
  readonly status: "passed" | "failed" | "incomplete" | "infrastructure-failure";
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly outputArtifactId?: string;
  readonly message?: string;
}

export interface RunManifestV1 {
  readonly schemaVersion: typeof RUN_MANIFEST_VERSION;
  readonly runId: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly baseSha: string;
  readonly campaignId: string;
  readonly specId: string;
  readonly specRevision: number;
  readonly versions: {
    readonly detector: string;
    readonly transformer: string;
    readonly prompt?: string;
    readonly model?: string;
    readonly sandboxImage?: string;
  };
  readonly findings: readonly MigrationFinding[];
  readonly allowedPaths: readonly string[];
  readonly patchSha256?: string;
  readonly validation: readonly ValidationCommandResult[];
  readonly networkPolicy: "offline" | "registry-only";
  readonly resourcePolicy: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  };
  readonly approval?: {
    readonly actorId: string;
    readonly patchSha256: string;
    readonly approvedAt: string;
  };
  readonly pullRequest?: {
    readonly id: number;
    readonly url: string;
    readonly branch: string;
  };
  readonly costUsd?: number;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly cleanup: {
    readonly status: "pending" | "complete" | "failed";
    readonly completedAt?: string;
    readonly message?: string;
  };
}
