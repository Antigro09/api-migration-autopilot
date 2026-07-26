import {
  assertNoUnknownKeys,
  finishValidation,
  isRecord,
  readArray,
  readBoolean,
  readEnum,
  readInteger,
  readIsoTimestamp,
  readJsonObject,
  readOptionalString,
  readSha256,
  readString,
  type JsonObject,
} from "./validation";

export const MIGRATION_SPEC_SCHEMA_VERSION = "1" as const;
export const MIGRATION_SPEC_STATUSES = ["draft", "approved", "superseded"] as const;
export type MigrationSpecStatus = (typeof MIGRATION_SPEC_STATUSES)[number];

export const CHANGE_SEVERITIES = [
  "informational",
  "low",
  "medium",
  "high",
  "breaking",
] as const;
export type ChangeSeverity = (typeof CHANGE_SEVERITIES)[number];

export const DETECTOR_KINDS = [
  "package_version",
  "import",
  "constructor",
  "symbol_reference",
  "call_expression",
  "text_fallback",
] as const;
export type DetectorKind = (typeof DETECTOR_KINDS)[number];

export const TRANSFORMATION_KINDS = [
  "deterministic_codemod",
  "parameterized_template",
  "model_residual",
  "manual",
] as const;
export type TransformationKind = (typeof TRANSFORMATION_KINDS)[number];

export interface MigrationSourceArtifactV1 {
  readonly id: string;
  readonly title: string;
  readonly kind:
    | "markdown"
    | "html"
    | "pdf"
    | "json"
    | "yaml"
    | "sdk_diff"
    | "openapi";
  readonly mediaType: string;
  readonly sha256: string;
  readonly externalUrl?: string;
}

export interface MigrationCitationV1 {
  readonly artifactId: string;
  readonly locator: string;
  readonly excerpt?: string;
}

export interface DetectorV1 {
  readonly kind: DetectorKind;
  readonly moduleName: string;
  readonly symbol?: string;
  readonly member?: string;
  readonly textPattern?: string;
  readonly callArgumentIndex?: number;
  readonly configuration: JsonObject;
}

export interface TransformationV1 {
  readonly kind: TransformationKind;
  readonly recipeId?: string;
  readonly promptVersion?: string;
  readonly parameters: JsonObject;
  readonly requiresModelConsent: boolean;
}

export interface MigrationChangeV1 {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly severity: ChangeSeverity;
  readonly citations: readonly MigrationCitationV1[];
  readonly detectors: readonly DetectorV1[];
  readonly transformation: TransformationV1;
  readonly behavioralInvariants: readonly string[];
  readonly validationHints: readonly string[];
  readonly autoPatchEligible: boolean;
  readonly knownLimitations: readonly string[];
}

export interface MigrationSpecV1 {
  readonly schemaVersion: typeof MIGRATION_SPEC_SCHEMA_VERSION;
  readonly id: string;
  readonly organizationId: string;
  readonly campaignId: string;
  readonly revision: number;
  readonly status: MigrationSpecStatus;
  readonly providerName: string;
  readonly productName: string;
  readonly package: {
    readonly ecosystem: "npm";
    readonly name: string;
    readonly language: "typescript";
    readonly sourceRange: string;
    readonly targetVersion: string;
  };
  readonly sourceArtifacts: readonly MigrationSourceArtifactV1[];
  readonly changes: readonly MigrationChangeV1[];
  readonly generalLimitations: readonly string[];
  readonly createdAt: string;
  readonly approvedAt?: string;
  readonly approvedByMembershipId?: string;
}

const ARTIFACT_KINDS = [
  "markdown",
  "html",
  "pdf",
  "json",
  "yaml",
  "sdk_diff",
  "openapi",
] as const;

const PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function readStringList(
  value: unknown,
  path: string,
  issues: string[],
  maxItems: number,
): string[] {
  const values = readArray(value, path, issues);
  if (values.length > maxItems) {
    issues.push(`${path} must contain at most ${maxItems} entries`);
  }
  return values.map((entry, index) =>
    readString(entry, `${path}[${index}]`, issues, { maxLength: 2_000 }),
  );
}

function readSourceArtifact(
  value: unknown,
  path: string,
  issues: string[],
): MigrationSourceArtifactV1 {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    value = {};
  }
  const record = value as Record<string, unknown>;
  assertNoUnknownKeys(
    record,
    ["id", "title", "kind", "mediaType", "sha256", "externalUrl"],
    path,
    issues,
  );
  const externalUrl = readOptionalString(
    record.externalUrl,
    `${path}.externalUrl`,
    issues,
    { maxLength: 2_048 },
  );
  if (externalUrl) {
    try {
      const parsed = new URL(externalUrl);
      if (parsed.protocol !== "https:") {
        issues.push(`${path}.externalUrl must use https`);
      }
    } catch {
      issues.push(`${path}.externalUrl must be an absolute URL`);
    }
  }

  return {
    id: readString(record.id, `${path}.id`, issues, {
      pattern: IDENTIFIER_PATTERN,
      maxLength: 128,
    }),
    title: readString(record.title, `${path}.title`, issues, {
      maxLength: 240,
    }),
    kind: readEnum(record.kind, ARTIFACT_KINDS, `${path}.kind`, issues),
    mediaType: readString(record.mediaType, `${path}.mediaType`, issues, {
      maxLength: 128,
    }),
    sha256: readSha256(record.sha256, `${path}.sha256`, issues),
    ...(externalUrl ? { externalUrl } : {}),
  };
}

function readCitation(
  value: unknown,
  path: string,
  issues: string[],
): MigrationCitationV1 {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    value = {};
  }
  const record = value as Record<string, unknown>;
  assertNoUnknownKeys(record, ["artifactId", "locator", "excerpt"], path, issues);
  const excerpt = readOptionalString(record.excerpt, `${path}.excerpt`, issues, {
    maxLength: 1_000,
  });
  return {
    artifactId: readString(record.artifactId, `${path}.artifactId`, issues, {
      pattern: IDENTIFIER_PATTERN,
      maxLength: 128,
    }),
    locator: readString(record.locator, `${path}.locator`, issues, {
      maxLength: 500,
    }),
    ...(excerpt ? { excerpt } : {}),
  };
}

function readDetector(
  value: unknown,
  path: string,
  issues: string[],
): DetectorV1 {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    value = {};
  }
  const record = value as Record<string, unknown>;
  assertNoUnknownKeys(
    record,
    [
      "kind",
      "moduleName",
      "symbol",
      "member",
      "textPattern",
      "callArgumentIndex",
      "configuration",
    ],
    path,
    issues,
  );
  const symbol = readOptionalString(record.symbol, `${path}.symbol`, issues, {
    maxLength: 160,
  });
  const member = readOptionalString(record.member, `${path}.member`, issues, {
    maxLength: 160,
  });
  const textPattern = readOptionalString(
    record.textPattern,
    `${path}.textPattern`,
    issues,
    { maxLength: 500 },
  );
  const callArgumentIndex =
    record.callArgumentIndex === undefined
      ? undefined
      : readInteger(
          record.callArgumentIndex,
          `${path}.callArgumentIndex`,
          issues,
          { min: 0, max: 32 },
        );

  return {
    kind: readEnum(record.kind, DETECTOR_KINDS, `${path}.kind`, issues),
    moduleName: readString(record.moduleName, `${path}.moduleName`, issues, {
      pattern: PACKAGE_NAME_PATTERN,
      maxLength: 214,
    }),
    ...(symbol ? { symbol } : {}),
    ...(member ? { member } : {}),
    ...(textPattern ? { textPattern } : {}),
    ...(callArgumentIndex === undefined ? {} : { callArgumentIndex }),
    configuration: readJsonObject(
      record.configuration ?? {},
      `${path}.configuration`,
      issues,
    ),
  };
}

function readTransformation(
  value: unknown,
  path: string,
  issues: string[],
): TransformationV1 {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    value = {};
  }
  const record = value as Record<string, unknown>;
  assertNoUnknownKeys(
    record,
    [
      "kind",
      "recipeId",
      "promptVersion",
      "parameters",
      "requiresModelConsent",
    ],
    path,
    issues,
  );
  const kind = readEnum(
    record.kind,
    TRANSFORMATION_KINDS,
    `${path}.kind`,
    issues,
  );
  const recipeId = readOptionalString(
    record.recipeId,
    `${path}.recipeId`,
    issues,
    { maxLength: 128, pattern: IDENTIFIER_PATTERN },
  );
  const promptVersion = readOptionalString(
    record.promptVersion,
    `${path}.promptVersion`,
    issues,
    { maxLength: 128, pattern: IDENTIFIER_PATTERN },
  );
  const requiresModelConsent = readBoolean(
    record.requiresModelConsent,
    `${path}.requiresModelConsent`,
    issues,
  );

  if (
    (kind === "deterministic_codemod" ||
      kind === "parameterized_template") &&
    !recipeId
  ) {
    issues.push(`${path}.recipeId is required for ${kind}`);
  }
  if (kind === "model_residual" && !promptVersion) {
    issues.push(`${path}.promptVersion is required for model_residual`);
  }
  if (kind === "model_residual" && !requiresModelConsent) {
    issues.push(`${path}.requiresModelConsent must be true for model_residual`);
  }
  if (kind !== "model_residual" && requiresModelConsent) {
    issues.push(
      `${path}.requiresModelConsent may only be true for model_residual`,
    );
  }

  return {
    kind,
    ...(recipeId ? { recipeId } : {}),
    ...(promptVersion ? { promptVersion } : {}),
    parameters: readJsonObject(
      record.parameters ?? {},
      `${path}.parameters`,
      issues,
    ),
    requiresModelConsent,
  };
}

function readChange(
  value: unknown,
  path: string,
  issues: string[],
): MigrationChangeV1 {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    value = {};
  }
  const record = value as Record<string, unknown>;
  assertNoUnknownKeys(
    record,
    [
      "id",
      "title",
      "description",
      "severity",
      "citations",
      "detectors",
      "transformation",
      "behavioralInvariants",
      "validationHints",
      "autoPatchEligible",
      "knownLimitations",
    ],
    path,
    issues,
  );
  const citations = readArray(record.citations, `${path}.citations`, issues).map(
    (citation, index) =>
      readCitation(citation, `${path}.citations[${index}]`, issues),
  );
  const detectors = readArray(record.detectors, `${path}.detectors`, issues).map(
    (detector, index) =>
      readDetector(detector, `${path}.detectors[${index}]`, issues),
  );
  const transformation = readTransformation(
    record.transformation,
    `${path}.transformation`,
    issues,
  );
  const autoPatchEligible = readBoolean(
    record.autoPatchEligible,
    `${path}.autoPatchEligible`,
    issues,
  );

  if (citations.length === 0) {
    issues.push(`${path}.citations must contain provider evidence`);
  }
  if (detectors.length === 0) {
    issues.push(`${path}.detectors must contain at least one detector`);
  }
  if (autoPatchEligible && transformation.kind === "manual") {
    issues.push(
      `${path}.autoPatchEligible cannot be true for a manual transformation`,
    );
  }

  return {
    id: readString(record.id, `${path}.id`, issues, {
      pattern: IDENTIFIER_PATTERN,
      maxLength: 128,
    }),
    title: readString(record.title, `${path}.title`, issues, {
      maxLength: 240,
    }),
    description: readString(record.description, `${path}.description`, issues, {
      maxLength: 4_000,
    }),
    severity: readEnum(
      record.severity,
      CHANGE_SEVERITIES,
      `${path}.severity`,
      issues,
    ),
    citations,
    detectors,
    transformation,
    behavioralInvariants: readStringList(
      record.behavioralInvariants,
      `${path}.behavioralInvariants`,
      issues,
      50,
    ),
    validationHints: readStringList(
      record.validationHints,
      `${path}.validationHints`,
      issues,
      50,
    ),
    autoPatchEligible,
    knownLimitations: readStringList(
      record.knownLimitations,
      `${path}.knownLimitations`,
      issues,
      50,
    ),
  };
}

export function parseMigrationSpecV1(value: unknown): MigrationSpecV1 {
  const issues: string[] = [];
  if (!isRecord(value)) {
    throw finishValidation(["MigrationSpecV1 must be an object"], null);
  }
  assertNoUnknownKeys(
    value,
    [
      "schemaVersion",
      "id",
      "organizationId",
      "campaignId",
      "revision",
      "status",
      "providerName",
      "productName",
      "package",
      "sourceArtifacts",
      "changes",
      "generalLimitations",
      "createdAt",
      "approvedAt",
      "approvedByMembershipId",
    ],
    "MigrationSpecV1",
    issues,
  );

  const packageValue = isRecord(value.package) ? value.package : {};
  if (!isRecord(value.package)) {
    issues.push("MigrationSpecV1.package must be an object");
  }
  assertNoUnknownKeys(
    packageValue,
    ["ecosystem", "name", "language", "sourceRange", "targetVersion"],
    "MigrationSpecV1.package",
    issues,
  );

  const sourceArtifacts = readArray(
    value.sourceArtifacts,
    "MigrationSpecV1.sourceArtifacts",
    issues,
  ).map((artifact, index) =>
    readSourceArtifact(
      artifact,
      `MigrationSpecV1.sourceArtifacts[${index}]`,
      issues,
    ),
  );
  const changes = readArray(
    value.changes,
    "MigrationSpecV1.changes",
    issues,
  ).map((change, index) =>
    readChange(change, `MigrationSpecV1.changes[${index}]`, issues),
  );

  const artifactIds = new Set<string>();
  for (const [index, artifact] of sourceArtifacts.entries()) {
    if (artifactIds.has(artifact.id)) {
      issues.push(
        `MigrationSpecV1.sourceArtifacts[${index}].id must be unique`,
      );
    }
    artifactIds.add(artifact.id);
  }
  const changeIds = new Set<string>();
  for (const [index, change] of changes.entries()) {
    if (changeIds.has(change.id)) {
      issues.push(`MigrationSpecV1.changes[${index}].id must be unique`);
    }
    changeIds.add(change.id);
    for (const [citationIndex, citation] of change.citations.entries()) {
      if (!artifactIds.has(citation.artifactId)) {
        issues.push(
          `MigrationSpecV1.changes[${index}].citations[${citationIndex}].artifactId does not reference a source artifact`,
        );
      }
    }
  }

  if (sourceArtifacts.length === 0) {
    issues.push(
      "MigrationSpecV1.sourceArtifacts must contain at least one immutable source",
    );
  }
  if (changes.length === 0) {
    issues.push("MigrationSpecV1.changes must contain at least one change");
  }

  const status = readEnum(
    value.status,
    MIGRATION_SPEC_STATUSES,
    "MigrationSpecV1.status",
    issues,
  );
  const approvedAt = readOptionalString(
    value.approvedAt,
    "MigrationSpecV1.approvedAt",
    issues,
  );
  if (approvedAt) {
    readIsoTimestamp(
      approvedAt,
      "MigrationSpecV1.approvedAt",
      issues,
    );
  }
  const approvedByMembershipId = readOptionalString(
    value.approvedByMembershipId,
    "MigrationSpecV1.approvedByMembershipId",
    issues,
    { maxLength: 128, pattern: IDENTIFIER_PATTERN },
  );
  if (
    status === "approved" &&
    (!approvedAt || !approvedByMembershipId)
  ) {
    issues.push(
      "Approved MigrationSpecV1 objects require approvedAt and approvedByMembershipId",
    );
  }
  if (
    status === "draft" &&
    (approvedAt !== undefined || approvedByMembershipId !== undefined)
  ) {
    issues.push(
      "Draft MigrationSpecV1 objects cannot contain approval metadata",
    );
  }

  const result: MigrationSpecV1 = {
    schemaVersion: readEnum(
      value.schemaVersion,
      [MIGRATION_SPEC_SCHEMA_VERSION] as const,
      "MigrationSpecV1.schemaVersion",
      issues,
    ),
    id: readString(value.id, "MigrationSpecV1.id", issues, {
      pattern: IDENTIFIER_PATTERN,
      maxLength: 128,
    }),
    organizationId: readString(
      value.organizationId,
      "MigrationSpecV1.organizationId",
      issues,
      { pattern: IDENTIFIER_PATTERN, maxLength: 128 },
    ),
    campaignId: readString(
      value.campaignId,
      "MigrationSpecV1.campaignId",
      issues,
      { pattern: IDENTIFIER_PATTERN, maxLength: 128 },
    ),
    revision: readInteger(
      value.revision,
      "MigrationSpecV1.revision",
      issues,
      { min: 1 },
    ),
    status,
    providerName: readString(
      value.providerName,
      "MigrationSpecV1.providerName",
      issues,
      { maxLength: 160 },
    ),
    productName: readString(
      value.productName,
      "MigrationSpecV1.productName",
      issues,
      { maxLength: 160 },
    ),
    package: {
      ecosystem: readEnum(
        packageValue.ecosystem,
        ["npm"] as const,
        "MigrationSpecV1.package.ecosystem",
        issues,
      ),
      name: readString(
        packageValue.name,
        "MigrationSpecV1.package.name",
        issues,
        { pattern: PACKAGE_NAME_PATTERN, maxLength: 214 },
      ),
      language: readEnum(
        packageValue.language,
        ["typescript"] as const,
        "MigrationSpecV1.package.language",
        issues,
      ),
      sourceRange: readString(
        packageValue.sourceRange,
        "MigrationSpecV1.package.sourceRange",
        issues,
        { maxLength: 128 },
      ),
      targetVersion: readString(
        packageValue.targetVersion,
        "MigrationSpecV1.package.targetVersion",
        issues,
        { pattern: /^[0-9A-Za-z][0-9A-Za-z.+-]*$/, maxLength: 128 },
      ),
    },
    sourceArtifacts,
    changes,
    generalLimitations: readStringList(
      value.generalLimitations,
      "MigrationSpecV1.generalLimitations",
      issues,
      100,
    ),
    createdAt: readIsoTimestamp(
      value.createdAt,
      "MigrationSpecV1.createdAt",
      issues,
    ),
    ...(approvedAt ? { approvedAt } : {}),
    ...(approvedByMembershipId ? { approvedByMembershipId } : {}),
  };

  return finishValidation(issues, result);
}

export function isMigrationSpecV1(value: unknown): value is MigrationSpecV1 {
  try {
    parseMigrationSpecV1(value);
    return true;
  } catch {
    return false;
  }
}
