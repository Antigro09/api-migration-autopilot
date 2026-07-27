import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import {
  canTransitionCampaign,
  parseMigrationSpecV1,
  sha256Hex,
  type CampaignState,
  type MigrationChangeV1 as DomainChange,
  type MigrationSpecV1 as DomainSpec,
  type TenantContext,
} from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import { stripeV20ToV22Spec } from "@/lib/migration/specs/stripe-v20-v22";
import { R2ArtifactStore } from "@/lib/platform/artifacts";
import { encryptArtifact } from "@/lib/platform/encryption";
import { extractProviderArtifact } from "@/lib/provider/artifact-intake";
import {
  appendAuditEvent,
  createCampaign,
  getCampaign,
  type CampaignRecord,
} from "./control-plane";

export type SpecReviewRecord = {
  id: string;
  campaignId: string;
  campaignName: string;
  revision: number;
  status: "draft" | "approved" | "superseded";
  contentSha256: string;
  submittedForReviewAt: string | null;
  content: DomainSpec;
  createdAt: string;
};

const REFERENCE_SOURCES = [
  {
    id: "stripe-node-changelog",
    title: "stripe-node changelog",
    url: "https://raw.githubusercontent.com/stripe/stripe-node/master/CHANGELOG.md",
    externalUrl:
      "https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md",
    kind: "markdown" as const,
    mediaType: "text/markdown",
  },
  {
    id: "stripe-node-v21-guide",
    title: "stripe-node v21 migration guide",
    url: "https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v21",
    externalUrl:
      "https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v21",
    kind: "html" as const,
    mediaType: "text/html",
  },
  {
    id: "stripe-node-v22-guide",
    title: "stripe-node v22 migration guide",
    url: "https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v22",
    externalUrl:
      "https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v22",
    kind: "html" as const,
    mediaType: "text/html",
  },
  {
    id: "stripe-api-dahlia",
    title: "Stripe API Dahlia changelog",
    url: "https://docs.stripe.com/changelog/dahlia",
    externalUrl: "https://docs.stripe.com/changelog/dahlia",
    kind: "html" as const,
    mediaType: "text/html",
  },
] as const;

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function detectorKind(ruleId: string): DomainChange["detectors"][number]["kind"] {
  if (ruleId.includes("runtime")) return "package_version";
  if (ruleId.includes("import")) return "import";
  if (ruleId.includes("constructor")) return "constructor";
  if (ruleId.includes("request")) return "call_expression";
  return "symbol_reference";
}

function severity(
  value: "info" | "warning" | "error",
): DomainChange["severity"] {
  if (value === "error") return "breaking";
  if (value === "warning") return "medium";
  return "informational";
}

function sourceIdForUrl(
  url: string,
  artifactIds: ReadonlyMap<string, string>,
): string {
  const baseId = url.includes("Migration-guide-for-v21")
    ? "stripe-node-v21-guide"
    : url.includes("Migration-guide-for-v22")
      ? "stripe-node-v22-guide"
      : url.includes("changelog/dahlia")
        ? "stripe-api-dahlia"
        : "stripe-node-changelog";
  const artifactId = artifactIds.get(baseId);
  if (!artifactId) throw new Error(`Missing reference source ${baseId}.`);
  return artifactId;
}

export function domainChange(
  change: (typeof stripeV20ToV22Spec.changes)[number],
  artifactIds: ReadonlyMap<string, string>,
): DomainChange {
  const transformation: DomainChange["transformation"] =
    change.transformation.kind === "deterministic"
      ? {
          kind: "deterministic_codemod",
          recipeId: change.transformation.transformerId,
          parameters: {},
          requiresModelConsent: false,
        }
      : change.transformation.kind === "template"
        ? {
            kind: "parameterized_template",
            recipeId: change.transformation.transformerId,
            parameters: {
              parameterNames: [...change.transformation.parameters],
            },
            requiresModelConsent: false,
          }
        : change.transformation.kind === "model-assisted"
          ? {
              kind: "model_residual",
              promptVersion: "stripe-residual-v1",
              parameters: { reason: change.transformation.reason },
              requiresModelConsent: true,
            }
          : {
              kind: "manual",
              parameters: { reason: change.transformation.reason },
              requiresModelConsent: false,
            };

  return {
    id: change.id,
    title: change.title,
    description: change.description,
    severity: severity(change.severity),
    citations: change.citations.map((citation) => ({
      artifactId: sourceIdForUrl(
        citation.url ??
          (() => {
            throw new Error("The reference campaign citation URL is missing.");
          })(),
        artifactIds,
      ),
      locator: citation.title,
      ...(citation.excerpt ? { excerpt: citation.excerpt } : {}),
    })),
    detectors: [
      {
        kind: detectorKind(change.id),
        moduleName: "stripe",
        configuration: {
          detector:
            change.detector.kind === "syntax-pattern"
              ? change.detector.patternIds.join(",")
              : change.detector.kind,
        },
      },
    ],
    transformation,
    behavioralInvariants: [...change.behavioralInvariants],
    validationHints: [...change.validationHints],
    autoPatchEligible: change.autoPatchEligible,
    knownLimitations: [...change.knownLimitations],
  };
}

async function fetchSource(source: (typeof REFERENCE_SOURCES)[number]) {
  const response = await fetch(source.url, {
    headers: { "User-Agent": "api-migration-autopilot" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(
      `Could not acquire ${source.title}: HTTP ${response.status}.`,
    );
  }
  const content = await response.arrayBuffer();
  if (content.byteLength === 0 || content.byteLength > 5 * 1024 * 1024) {
    throw new Error(`${source.title} exceeds the 5 MiB evidence limit.`);
  }
  const digest = await crypto.subtle.digest("SHA-256", content);
  return {
    ...source,
    content,
    sha256: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}

export async function createStripeReferenceCampaign(
  tenant: TenantContext,
): Promise<{ campaign: CampaignRecord; spec: SpecReviewRecord }> {
  await ensureDatabaseSchema();
  const existing = await getD1()
    .prepare(
      `SELECT id
       FROM campaigns
       WHERE organization_id = ?
         AND independent_reference = true
         AND package_name = 'stripe'
         AND status <> 'archived'
       LIMIT 1`,
    )
    .bind(tenant.organizationId)
    .first<{ id: string }>();
  if (existing) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "An active Stripe reference campaign already exists.",
    );
  }
  const sources = await Promise.all(REFERENCE_SOURCES.map(fetchSource));
  const campaign = await createCampaign(tenant, {
    productName: "Stripe Node SDK",
    packageName: "stripe",
    sourceRange: ">=20.3.0 <21.0.0",
    targetVersion: "22.1.0",
    notes:
      "Independent reference campaign for the 2026-03-25.dahlia transition and selected v21/v22 SDK changes. No Stripe sponsorship or endorsement is implied.",
  });
  const specId = id("spec");
  const now = new Date().toISOString();
  const storage = new R2ArtifactStore();
  const idSuffix = campaign.id.slice(-8);
  const storedSources = await Promise.all(
    sources.map(async (source) => {
      const bytes = new Uint8Array(source.content);
      const extracted = await extractProviderArtifact({
        bytes,
        mediaType: source.mediaType,
        kind: source.kind,
        externalUrl: source.externalUrl,
      });
      const rawEnvelope = await encryptArtifact(bytes);
      const extractedEnvelope = await encryptArtifact(extracted.text);
      return {
        ...source,
        id: `${source.id}-${idSuffix}`,
        storageKey: `campaigns/${campaign.id}/sources/${source.id}/raw`,
        extractedStorageKey: `campaigns/${campaign.id}/sources/${source.id}/extracted.txt`,
        rawEnvelope,
        extractedEnvelope,
        extracted,
      };
    }),
  );
  const artifactIds = new Map(
    sources.map((source, index) => [
      source.id,
      (storedSources[index] as (typeof storedSources)[number]).id,
    ]),
  );

  for (const source of storedSources) {
    await storage.put(
      tenant.organizationId,
      source.storageKey,
      source.rawEnvelope.body,
      {
        contentType: "application/octet-stream",
        retention: "audit-manifest",
        sha256: source.sha256,
      },
    );
    await storage.put(
      tenant.organizationId,
      source.extractedStorageKey,
      source.extractedEnvelope.body,
      {
        contentType: "application/octet-stream",
        retention: "audit-manifest",
        sha256: source.extractedEnvelope.plaintextSha256,
      },
    );
  }

  const spec = parseMigrationSpecV1({
    schemaVersion: "1",
    id: specId,
    organizationId: tenant.organizationId,
    campaignId: campaign.id,
    revision: 1,
    status: "draft",
    providerName: "Independent Stripe reference",
    productName: "stripe-node",
    package: {
      ecosystem: "npm",
      name: "stripe",
      language: "typescript",
      sourceRange: ">=20.3.0 <21.0.0",
      targetVersion: "22.1.0",
    },
    sourceArtifacts: storedSources.map((source) => ({
      id: source.id,
      title: source.title,
      kind: source.kind,
      mediaType: source.mediaType,
      sha256: source.sha256,
      externalUrl: source.externalUrl,
    })),
    changes: stripeV20ToV22Spec.changes.map((change) =>
      domainChange(change, artifactIds),
    ),
    generalLimitations: [
      "Independent public reference; Stripe has not sponsored or approved this campaign.",
      "Dynamic imports, generated code, wrapper APIs, external runtime configuration, and private dependencies may require manual review.",
      "The API version transition is pinned to 2026-03-25.dahlia for this reference revision.",
    ],
    createdAt: now,
  });
  const contentSha256 = await sha256Hex(JSON.stringify(spec));
  const database = getD1();
  const statements = [
    getD1()
      .prepare(
        `INSERT INTO migration_specs (
          id, organization_id, campaign_id, revision, status, content,
          content_sha256, submitted_for_review_at, created_by_membership_id
        ) VALUES (?, ?, ?, 1, 'draft', ?, ?, ?, ?)`,
      )
      .bind(
        specId,
        tenant.organizationId,
        campaign.id,
        JSON.stringify(spec),
        contentSha256,
        now,
        tenant.membershipId,
      ),
    getD1()
      .prepare(
        `UPDATE campaigns
         SET independent_reference = true, current_spec_id = ?,
             status = 'provider_review', updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(specId, now, campaign.id, tenant.organizationId),
    ...storedSources.map((source) =>
      database
        .prepare(
          `INSERT INTO source_artifacts (
            id, organization_id, campaign_id, migration_spec_id,
            title, source_kind, media_type, storage_key, sha256,
            encryption_key_id, extracted_storage_key, extracted_sha256,
            extracted_encryption_key_id, extraction_status,
            extraction_message, page_count, external_url, size_bytes,
            uploaded_by_membership_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          source.id,
          tenant.organizationId,
          campaign.id,
          specId,
          source.title,
          source.kind,
          source.mediaType,
          source.storageKey,
          source.sha256,
          source.rawEnvelope.encryptionKeyId,
          source.extractedStorageKey,
          source.extractedEnvelope.plaintextSha256,
          source.extractedEnvelope.encryptionKeyId,
          source.extracted.status,
          source.extracted.message ?? null,
          source.extracted.pageCount ?? null,
          source.externalUrl,
          source.content.byteLength,
          tenant.membershipId,
        ),
    ),
  ];
  try {
    await database.batch(statements);
  } catch (error) {
    await Promise.allSettled(
      storedSources.map((source) =>
        Promise.all([
          storage.delete(tenant.organizationId, source.storageKey),
          storage.delete(
            tenant.organizationId,
            source.extractedStorageKey,
          ),
        ]),
      ),
    );
    throw error;
  }
  await appendAuditEvent({
    organizationId: tenant.organizationId,
    aggregateType: "campaign",
    aggregateId: campaign.id,
    action: "migration_spec.created",
    actorMembershipId: tenant.membershipId,
    payload: {
      specId,
      revision: 1,
      contentSha256,
      independentReference: true,
      artifactCount: storedSources.length,
    },
  });
  const persistedCampaign = await getCampaign(
    tenant.organizationId,
    campaign.id,
  );
  if (!persistedCampaign) throw new Error("Reference campaign was not reloaded.");
  return {
    campaign: persistedCampaign,
    spec: {
      id: specId,
      campaignId: campaign.id,
      campaignName: persistedCampaign.name,
      revision: 1,
      status: "draft",
      contentSha256,
      submittedForReviewAt: now,
      content: spec,
      createdAt: now,
    },
  };
}

export async function listSpecsForReview(
  organizationId: string,
): Promise<SpecReviewRecord[]> {
  await ensureDatabaseSchema();
  const result = await getD1()
    .prepare(
      `SELECT
        ms.id,
        ms.campaign_id AS campaignId,
        c.name AS campaignName,
        ms.revision,
        ms.status,
        ms.content_sha256 AS contentSha256,
        ms.submitted_for_review_at AS submittedForReviewAt,
        ms.content,
        ms.created_at AS createdAt
       FROM migration_specs ms
       JOIN campaigns c ON c.id = ms.campaign_id
       WHERE ms.organization_id = ?
         AND ms.status IN ('draft', 'approved')
       ORDER BY ms.created_at DESC`,
    )
    .bind(organizationId)
    .all<Omit<SpecReviewRecord, "content"> & { content: string }>();
  return result.results.map((row) => ({
    ...row,
    content:
      typeof row.content === "string"
        ? parseMigrationSpecV1(JSON.parse(row.content))
        : parseMigrationSpecV1(row.content),
  }));
}

export async function approveMigrationSpec(input: {
  tenant: TenantContext;
  campaignId: string;
  specId: string;
  expectedContentSha256: string;
}): Promise<{ approvedContentSha256: string }> {
  await ensureDatabaseSchema();
  if (
    input.tenant.organizationKind !== "provider" ||
    (input.tenant.role !== "admin" &&
      input.tenant.role !== "approver")
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "An organization approver is required.",
    );
  }
  const record = await getD1()
    .prepare(
      `SELECT ms.content, ms.content_sha256 AS contentSha256, ms.status,
              ms.submitted_for_review_at AS submittedForReviewAt,
              c.status AS campaignStatus,
              c.current_spec_id AS currentSpecId
       FROM migration_specs ms
       JOIN campaigns c ON c.id = ms.campaign_id
       WHERE ms.id = ? AND ms.campaign_id = ?
         AND ms.organization_id = ? AND c.organization_id = ?
       LIMIT 1`,
    )
    .bind(
      input.specId,
      input.campaignId,
      input.tenant.organizationId,
      input.tenant.organizationId,
    )
    .first<{
      content: string | DomainSpec;
      contentSha256: string;
      status: string;
      submittedForReviewAt: string | null;
      campaignStatus: CampaignState;
      currentSpecId: string | null;
    }>();
  if (!record) throw new DomainError("NOT_FOUND", "Migration spec not found.");
  if (
    record.status !== "draft" ||
    !record.submittedForReviewAt ||
    !["provider_review", "approved", "live", "paused"].includes(
      record.campaignStatus,
    )
  ) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "Only a submitted draft for an active campaign can be approved.",
    );
  }
  if (record.contentSha256 !== input.expectedContentSha256) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The specification changed after this review loaded.",
    );
  }
  const draft = parseMigrationSpecV1(
    typeof record.content === "string"
      ? JSON.parse(record.content)
      : record.content,
  );
  const approvedAt = new Date().toISOString();
  const approved = parseMigrationSpecV1({
    ...draft,
    status: "approved",
    approvedAt,
    approvedByMembershipId: input.tenant.membershipId,
  });
  const approvedContentSha256 = await sha256Hex(JSON.stringify(approved));
  const results = await getD1().batch([
    getD1()
      .prepare(
        `UPDATE campaigns
         SET status = CASE WHEN status = 'provider_review'
                           THEN 'approved' ELSE status END,
             current_spec_id = ?, updated_at = ?
         WHERE id = ? AND organization_id = ?
           AND status IN ('provider_review', 'approved', 'live', 'paused')
           AND EXISTS (
             SELECT 1 FROM migration_specs
             WHERE id = ? AND campaign_id = campaigns.id
               AND organization_id = campaigns.organization_id
               AND status = 'draft' AND content_sha256 = ?
               AND submitted_for_review_at IS NOT NULL
           )`,
      )
      .bind(
        input.specId,
        approvedAt,
        input.campaignId,
        input.tenant.organizationId,
        input.specId,
        input.expectedContentSha256,
      ),
    getD1()
      .prepare(
        `UPDATE migration_specs
         SET status = 'approved', content = ?, content_sha256 = ?,
             approved_by_membership_id = ?, approved_at = ?
         WHERE id = ? AND organization_id = ?
           AND status = 'draft' AND content_sha256 = ?
           AND EXISTS (
             SELECT 1 FROM campaigns
             WHERE campaigns.id = migration_specs.campaign_id
               AND campaigns.organization_id = migration_specs.organization_id
               AND campaigns.current_spec_id = migration_specs.id
           )`,
      )
      .bind(
        JSON.stringify(approved),
        approvedContentSha256,
        input.tenant.membershipId,
        approvedAt,
        input.specId,
        input.tenant.organizationId,
        input.expectedContentSha256,
      ),
    getD1()
      .prepare(
        `UPDATE migration_specs
         SET status = 'superseded'
         WHERE campaign_id = ? AND organization_id = ?
           AND id <> ? AND status = 'approved'`,
      )
      .bind(
        input.campaignId,
        input.tenant.organizationId,
        input.specId,
      ),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The specification or campaign changed while approval was recorded.",
    );
  }
  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "campaign",
    aggregateId: input.campaignId,
    action: "migration_spec.approved",
    actorMembershipId: input.tenant.membershipId,
    payload: {
      specId: input.specId,
      reviewedContentSha256: input.expectedContentSha256,
      approvedContentSha256,
      supersededSpecId:
        record.currentSpecId === input.specId ? null : record.currentSpecId,
    },
  });
  return { approvedContentSha256 };
}

export async function transitionCampaign(input: {
  tenant: TenantContext;
  campaignId: string;
  target: Extract<CampaignState, "live" | "paused" | "completed" | "archived">;
}): Promise<void> {
  await ensureDatabaseSchema();
  if (
    input.tenant.organizationKind !== "provider" ||
    !["admin", "operator"].includes(input.tenant.role)
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "A provider admin or operator is required to change campaign state.",
    );
  }
  const campaign = await getCampaign(
    input.tenant.organizationId,
    input.campaignId,
  );
  if (!campaign) throw new DomainError("NOT_FOUND", "Campaign not found.");
  if (!canTransitionCampaign(campaign.status, input.target)) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      `The campaign cannot move from ${campaign.status} to ${input.target}.`,
    );
  }
  const now = new Date().toISOString();
  const result = await getD1()
    .prepare(
      `UPDATE campaigns
       SET status = ?,
           launched_at = CASE WHEN ? = 'live'
                              THEN COALESCE(launched_at, ?) ELSE launched_at END,
           completed_at = CASE WHEN ? = 'completed'
                               THEN ? ELSE completed_at END,
           archived_at = CASE WHEN ? = 'archived'
                              THEN ? ELSE archived_at END,
           updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = ?`,
    )
    .bind(
      input.target,
      input.target,
      now,
      input.target,
      now,
      input.target,
      now,
      now,
      campaign.id,
      input.tenant.organizationId,
      campaign.status,
    )
    .run();
  if (result.meta.changes !== 1) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The campaign changed while the state transition was recorded.",
    );
  }
  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "campaign",
    aggregateId: campaign.id,
    action: `campaign.${input.target}`,
    actorMembershipId: input.tenant.membershipId,
    payload: { from: campaign.status, to: input.target },
  });
}

export async function launchCampaign(input: {
  tenant: TenantContext;
  campaignId: string;
}): Promise<void> {
  await ensureDatabaseSchema();
  if (
    input.tenant.organizationKind !== "provider" ||
    (input.tenant.role !== "admin" && input.tenant.role !== "operator")
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "Your organization role cannot launch campaigns.",
    );
  }
  const campaign = await getCampaign(
    input.tenant.organizationId,
    input.campaignId,
  );
  if (!campaign) throw new DomainError("NOT_FOUND", "Campaign not found.");
  if (campaign.status !== "approved" || !campaign.currentSpecId) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "The campaign needs an approved specification before launch.",
    );
  }
  const now = new Date().toISOString();
  const result = await getD1()
    .prepare(
      `UPDATE campaigns
       SET status = 'live', launched_at = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'approved'`,
    )
    .bind(now, now, campaign.id, input.tenant.organizationId)
    .run();
  if (result.meta.changes !== 1) {
    throw new DomainError(
      "CONCURRENT_MODIFICATION",
      "The campaign changed while launch was recorded.",
    );
  }
  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "campaign",
    aggregateId: campaign.id,
    action: "campaign.launched",
    actorMembershipId: input.tenant.membershipId,
    payload: { specId: campaign.currentSpecId },
  });
}
