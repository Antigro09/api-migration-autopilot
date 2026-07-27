import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import {
  parseMigrationSpecV1,
  sha256Hex,
  type ChangeSeverity,
  type DetectorKind,
  type MigrationChangeV1,
  type MigrationSpecV1,
  type TenantContext,
  type TransformationKind,
} from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import {
  listProviderArtifacts,
  type ProviderSourceArtifact,
} from "./provider-artifacts";
import { appendAuditEvent } from "./control-plane";

export type ProviderRuleInput = {
  campaignId: string;
  id: string;
  title: string;
  description: string;
  severity: ChangeSeverity;
  artifactId: string;
  locator: string;
  excerpt?: string;
  detectorKind: DetectorKind;
  moduleName: string;
  symbol?: string;
  member?: string;
  textPattern?: string;
  callArgumentIndex?: number;
  transformationKind: TransformationKind;
  beforeExample?: string;
  afterExample?: string;
  rationale?: string;
  autoPatchEligible: boolean;
  behavioralInvariants: string[];
  validationHints: string[];
  knownLimitations: string[];
  generalLimitations: string[];
};

type CampaignAuthoringContext = {
  id: string;
  status: string;
  name: string;
  packageName: string;
  sourceRange: string;
  targetVersion: string;
  productName: string;
  providerName: string;
};

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function assertProviderAuthor(tenant: TenantContext): void {
  if (
    tenant.organizationKind !== "provider" ||
    !["admin", "operator"].includes(tenant.role)
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "Only a provider admin or operator can author migration rules.",
    );
  }
}

function text(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${label} is required and must be at most ${maximum} characters.`,
    );
  }
  return normalized;
}

function optionalText(value: string | undefined, maximum: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximum) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Rule text must be at most ${maximum} characters.`,
    );
  }
  return normalized;
}

function boundedList(
  values: readonly string[],
  label: string,
  maximumItems = 50,
): string[] {
  const normalized = [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ];
  if (
    normalized.length > maximumItems ||
    normalized.some((entry) => entry.length > 2_000)
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${label} contains too many or overly long entries.`,
    );
  }
  return normalized;
}

async function campaignContext(
  tenant: TenantContext,
  campaignId: string,
): Promise<CampaignAuthoringContext> {
  const campaign = await getD1()
    .prepare(
      `SELECT
         c.id, c.status, c.name, c.package_name AS packageName,
         c.source_range AS sourceRange, c.target_version AS targetVersion,
         p.name AS productName, o.name AS providerName
       FROM campaigns c
       JOIN api_products p ON p.id = c.product_id
       JOIN organizations o ON o.id = c.organization_id
       WHERE c.id = ? AND c.organization_id = ?
       LIMIT 1`,
    )
    .bind(campaignId, tenant.organizationId)
    .first<CampaignAuthoringContext>();
  if (!campaign) {
    throw new DomainError(
      "NOT_FOUND",
      "The campaign was not found in this provider organization.",
    );
  }
  if (["completed", "archived"].includes(campaign.status)) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "Completed or archived campaigns cannot be revised.",
    );
  }
  return campaign;
}

function transformationFor(input: ProviderRuleInput): MigrationChangeV1["transformation"] {
  const before = optionalText(input.beforeExample, 20_000);
  const after = optionalText(input.afterExample, 20_000);
  const rationale = optionalText(input.rationale, 2_000);
  if (input.transformationKind === "parameterized_template") {
    if (!before || !after || before === after) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "A parameterized template needs distinct before and after examples.",
      );
    }
    return {
      kind: "parameterized_template",
      recipeId: "literal-text-replacement-v1",
      parameters: { before, after, ...(rationale ? { rationale } : {}) },
      requiresModelConsent: false,
    };
  }
  if (input.transformationKind === "model_residual") {
    return {
      kind: "model_residual",
      promptVersion: "generic-provider-residual-v1",
      parameters: {
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
        ...(rationale ? { rationale } : {}),
      },
      requiresModelConsent: true,
    };
  }
  if (input.transformationKind === "deterministic_codemod") {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Deterministic codemod recipes must be installed and versioned by an internal operator; provider input cannot introduce executable code.",
    );
  }
  return {
    kind: "manual",
    parameters: { ...(rationale ? { rationale } : {}) },
    requiresModelConsent: false,
  };
}

function detectorFor(input: ProviderRuleInput): MigrationChangeV1["detectors"][number] {
  const moduleName = text(input.moduleName, "Module name", 214);
  const symbol = optionalText(input.symbol, 256);
  const member = optionalText(input.member, 256);
  const textPattern = optionalText(input.textPattern, 1_000);
  if (
    input.detectorKind === "text_fallback" &&
    !textPattern
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "A text fallback detector needs an explicit bounded text pattern.",
    );
  }
  return {
    kind: input.detectorKind,
    moduleName,
    ...(symbol ? { symbol } : {}),
    ...(member ? { member } : {}),
    ...(textPattern ? { textPattern } : {}),
    ...(input.callArgumentIndex === undefined
      ? {}
      : { callArgumentIndex: input.callArgumentIndex }),
    configuration: {
      authoringMode: "provider-declarative-v1",
    },
  };
}

async function latestDraftSpec(
  organizationId: string,
  campaignId: string,
): Promise<{
  id: string;
  revision: number;
  content: MigrationSpecV1;
} | null> {
  const row = await getD1()
    .prepare(
      `SELECT id, revision, content
       FROM migration_specs
       WHERE organization_id = ? AND campaign_id = ? AND status = 'draft'
       ORDER BY revision DESC LIMIT 1`,
    )
    .bind(organizationId, campaignId)
    .first<{ id: string; revision: number; content: string | MigrationSpecV1 }>();
  if (!row) return null;
  return {
    id: row.id,
    revision: row.revision,
    content: parseMigrationSpecV1(
      typeof row.content === "string" ? JSON.parse(row.content) : row.content,
    ),
  };
}

async function nextRevision(
  organizationId: string,
  campaignId: string,
): Promise<number> {
  const row = await getD1()
    .prepare(
      `SELECT COALESCE(MAX(revision), 0) AS revision
       FROM migration_specs
       WHERE organization_id = ? AND campaign_id = ?`,
    )
    .bind(organizationId, campaignId)
    .first<{ revision: number }>();
  return Number(row?.revision ?? 0) + 1;
}

function sourceArtifactContract(
  artifact: ProviderSourceArtifact,
): MigrationSpecV1["sourceArtifacts"][number] {
  return {
    id: artifact.id,
    title: artifact.title,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    sha256: artifact.sha256,
    ...(artifact.externalUrl ? { externalUrl: artifact.externalUrl } : {}),
  };
}

export async function saveProviderRule(input: {
  tenant: TenantContext;
  rule: ProviderRuleInput;
}): Promise<{ specId: string; revision: number; contentSha256: string }> {
  await ensureDatabaseSchema();
  assertProviderAuthor(input.tenant);
  const campaign = await campaignContext(input.tenant, input.rule.campaignId);
  const artifacts = await listProviderArtifacts(
    input.tenant.organizationId,
    campaign.id,
  );
  if (artifacts.length === 0) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "Upload at least one immutable evidence artifact before authoring rules.",
    );
  }
  const citationArtifact = artifacts.find(
    (artifact) => artifact.id === input.rule.artifactId,
  );
  if (!citationArtifact) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The selected citation does not belong to this campaign.",
    );
  }
  const ruleId = text(input.rule.id, "Rule ID", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ruleId)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Rule ID may contain letters, numbers, dots, colons, underscores, and hyphens.",
    );
  }
  const transformation = transformationFor(input.rule);
  const autoPatchEligible =
    input.rule.autoPatchEligible && transformation.kind !== "manual";
  const excerpt =
    optionalText(input.rule.excerpt, 4_000) ??
    citationArtifact.preview?.slice(0, 4_000);
  const change: MigrationChangeV1 = {
    id: ruleId,
    title: text(input.rule.title, "Rule title", 240),
    description: text(input.rule.description, "Rule description", 4_000),
    severity: input.rule.severity,
    citations: [
      {
        artifactId: citationArtifact.id,
        locator: text(input.rule.locator, "Evidence locator", 1_000),
        ...(excerpt ? { excerpt } : {}),
      },
    ],
    detectors: [detectorFor(input.rule)],
    transformation,
    behavioralInvariants: boundedList(
      input.rule.behavioralInvariants,
      "Behavioral invariants",
    ),
    validationHints: boundedList(
      input.rule.validationHints,
      "Validation hints",
    ),
    autoPatchEligible,
    knownLimitations: boundedList(
      input.rule.knownLimitations,
      "Known limitations",
    ),
  };
  if (
    change.behavioralInvariants.length === 0 ||
    change.validationHints.length === 0 ||
    change.knownLimitations.length === 0
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Every rule needs a behavioral invariant, validation hint, and known limitation.",
    );
  }

  const draft = await latestDraftSpec(
    input.tenant.organizationId,
    campaign.id,
  );
  const now = new Date().toISOString();
  const specId = draft?.id ?? id("spec");
  const revision =
    draft?.revision ??
    (await nextRevision(input.tenant.organizationId, campaign.id));
  const existingChanges = draft?.content.changes ?? [];
  const changes = [
    ...existingChanges.filter((candidate) => candidate.id !== change.id),
    change,
  ];
  const content = parseMigrationSpecV1({
    schemaVersion: "1",
    id: specId,
    organizationId: input.tenant.organizationId,
    campaignId: campaign.id,
    revision,
    status: "draft",
    providerName: campaign.providerName,
    productName: campaign.productName,
    package: {
      ecosystem: "npm",
      name: campaign.packageName,
      language: "typescript",
      sourceRange: campaign.sourceRange,
      targetVersion: campaign.targetVersion,
    },
    sourceArtifacts: artifacts.map(sourceArtifactContract),
    changes,
    generalLimitations: boundedList(
      [
        ...(draft?.content.generalLimitations ?? []),
        ...input.rule.generalLimitations,
      ],
      "General limitations",
      100,
    ),
    createdAt: draft?.content.createdAt ?? now,
  });
  const contentSha256 = await sha256Hex(JSON.stringify(content));
  const database = getD1();
  if (draft) {
    await database
      .prepare(
        `UPDATE migration_specs
         SET content = ?, content_sha256 = ?, submitted_for_review_at = null
         WHERE id = ? AND organization_id = ? AND status = 'draft'`,
      )
      .bind(
        JSON.stringify(content),
        contentSha256,
        specId,
        input.tenant.organizationId,
      )
      .run();
  } else {
    await database
      .prepare(
        `INSERT INTO migration_specs (
          id, organization_id, campaign_id, revision, status, content,
          content_sha256, created_by_membership_id
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
      )
      .bind(
        specId,
        input.tenant.organizationId,
        campaign.id,
        revision,
        JSON.stringify(content),
        contentSha256,
        input.tenant.membershipId,
      )
      .run();
  }
  await database
    .prepare(
      `UPDATE campaigns
       SET status = CASE WHEN status = 'draft'
                         THEN 'internal_authoring' ELSE status END,
           updated_at = ?
       WHERE id = ? AND organization_id = ?`,
    )
    .bind(now, campaign.id, input.tenant.organizationId)
    .run();
  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "campaign",
    aggregateId: campaign.id,
    action: draft ? "migration_spec.rule_updated" : "migration_spec.draft_created",
    actorMembershipId: input.tenant.membershipId,
    payload: {
      specId,
      revision,
      ruleId: change.id,
      contentSha256,
      changeCount: changes.length,
    },
  });
  return { specId, revision, contentSha256 };
}

export async function submitProviderSpecForReview(input: {
  tenant: TenantContext;
  campaignId: string;
  specId: string;
  expectedContentSha256: string;
}): Promise<void> {
  await ensureDatabaseSchema();
  assertProviderAuthor(input.tenant);
  const campaign = await campaignContext(input.tenant, input.campaignId);
  const spec = await getD1()
    .prepare(
      `SELECT content, content_sha256 AS contentSha256, status
       FROM migration_specs
       WHERE id = ? AND campaign_id = ? AND organization_id = ?
       LIMIT 1`,
    )
    .bind(input.specId, campaign.id, input.tenant.organizationId)
    .first<{
      content: string | MigrationSpecV1;
      contentSha256: string;
      status: string;
    }>();
  if (!spec || spec.status !== "draft") {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "Only the current draft specification can enter provider review.",
    );
  }
  if (spec.contentSha256 !== input.expectedContentSha256) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The specification changed after this review loaded.",
    );
  }
  const parsed = parseMigrationSpecV1(
    typeof spec.content === "string" ? JSON.parse(spec.content) : spec.content,
  );
  if (
    parsed.changes.length === 0 ||
    parsed.sourceArtifacts.length === 0 ||
    parsed.changes.some(
      (change) =>
        change.citations.length === 0 ||
        change.detectors.length === 0 ||
        change.validationHints.length === 0 ||
        change.knownLimitations.length === 0,
    )
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Every rule must be evidenced, detectable, validated, and explicit about limitations before provider review.",
    );
  }
  const now = new Date().toISOString();
  const reviewResults = await getD1().batch([
      getD1()
        .prepare(
          `UPDATE migration_specs
           SET submitted_for_review_at = ?
           WHERE id = ? AND campaign_id = ? AND organization_id = ?
             AND status = 'draft' AND content_sha256 = ?`,
        )
        .bind(
          now,
          input.specId,
          campaign.id,
          input.tenant.organizationId,
          input.expectedContentSha256,
        ),
      getD1()
        .prepare(
          `UPDATE campaigns
           SET status = CASE WHEN status IN ('draft', 'internal_authoring')
                             THEN 'provider_review' ELSE status END,
               updated_at = ?
           WHERE id = ? AND organization_id = ?
             AND EXISTS (
               SELECT 1 FROM migration_specs
               WHERE migration_specs.id = ?
                 AND migration_specs.campaign_id = campaigns.id
                 AND migration_specs.organization_id = campaigns.organization_id
                 AND migration_specs.status = 'draft'
                 AND migration_specs.content_sha256 = ?
                 AND migration_specs.submitted_for_review_at = ?
             )`,
        )
        .bind(
          now,
          campaign.id,
          input.tenant.organizationId,
          input.specId,
          input.expectedContentSha256,
          now,
        ),
    ]);
  if (
    reviewResults[0]?.meta.changes !== 1 ||
    reviewResults[1]?.meta.changes !== 1
  ) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The specification changed while it was submitted for review.",
    );
  }
  for (const artifact of parsed.sourceArtifacts) {
    await getD1()
      .prepare(
        `UPDATE source_artifacts
         SET migration_spec_id = ?
         WHERE id = ? AND organization_id = ? AND campaign_id = ?`,
      )
      .bind(
        input.specId,
        artifact.id,
        input.tenant.organizationId,
        campaign.id,
      )
      .run();
  }
  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "campaign",
    aggregateId: campaign.id,
    action: "migration_spec.submitted_for_provider_review",
    actorMembershipId: input.tenant.membershipId,
    payload: {
      specId: input.specId,
      contentSha256: spec.contentSha256,
      ruleCount: parsed.changes.length,
      artifactCount: parsed.sourceArtifacts.length,
    },
  });
}
