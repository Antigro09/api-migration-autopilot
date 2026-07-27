import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import type { TenantContext } from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import {
  acquireProviderArtifactUrl,
  acquireUploadedProviderArtifact,
  extractProviderArtifact,
  type AcquiredProviderArtifact,
  type ProviderArtifactKind,
} from "@/lib/provider/artifact-intake";
import { R2ArtifactStore } from "@/lib/platform/artifacts";
import { decryptArtifact, encryptArtifact } from "@/lib/platform/encryption";
import { appendAuditEvent } from "./control-plane";

export type ProviderSourceArtifact = {
  id: string;
  campaignId: string;
  migrationSpecId: string | null;
  title: string;
  kind: ProviderArtifactKind;
  mediaType: string;
  sha256: string;
  externalUrl: string | null;
  sizeBytes: number;
  extractionStatus: "pending" | "complete" | "incomplete" | "failed";
  extractionMessage: string | null;
  pageCount: number | null;
  preview: string | null;
  createdAt: string;
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
      "Only a provider admin or operator can add migration evidence.",
    );
  }
}

async function requireOwnedCampaign(
  tenant: TenantContext,
  campaignId: string,
): Promise<{ id: string; status: string }> {
  const campaign = await getD1()
    .prepare(
      `SELECT id, status FROM campaigns
       WHERE id = ? AND organization_id = ?
       LIMIT 1`,
    )
    .bind(campaignId, tenant.organizationId)
    .first<{ id: string; status: string }>();
  if (!campaign) {
    throw new DomainError(
      "NOT_FOUND",
      "The campaign was not found in this provider organization.",
    );
  }
  if (["completed", "archived"].includes(campaign.status)) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      "Completed or archived campaigns cannot accept new evidence.",
    );
  }
  return campaign;
}

function requiredTitle(value: string): string {
  const title = value.trim();
  if (!title || title.length > 240) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Artifact title is required and must be at most 240 characters.",
    );
  }
  return title;
}

async function storeAcquiredArtifact(input: {
  tenant: TenantContext;
  campaignId: string;
  title: string;
  artifact: AcquiredProviderArtifact;
}): Promise<ProviderSourceArtifact> {
  const campaign = await requireOwnedCampaign(input.tenant, input.campaignId);
  const title = requiredTitle(input.title);
  let extracted;
  try {
    extracted = await extractProviderArtifact(input.artifact);
  } catch (error) {
    throw new DomainError(
      "VALIDATION_FAILED",
      error instanceof Error
        ? `Evidence extraction failed: ${error.message.slice(0, 300)}`
        : "Evidence extraction failed.",
    );
  }

  const artifactId = id("src");
  const rawStorageKey = `campaigns/${campaign.id}/sources/${artifactId}/raw`;
  const extractedStorageKey = `campaigns/${campaign.id}/sources/${artifactId}/extracted.txt`;
  const rawEnvelope = await encryptArtifact(input.artifact.bytes);
  const sourceSha256 = rawEnvelope.plaintextSha256;
  const extractedEnvelope = await encryptArtifact(extracted.text);
  const storage = new R2ArtifactStore();
  await storage.put(
    input.tenant.organizationId,
    rawStorageKey,
    rawEnvelope.body,
    {
      contentType: "application/octet-stream",
      retention: "audit-manifest",
      sha256: sourceSha256,
    },
  );
  try {
    await storage.put(
      input.tenant.organizationId,
      extractedStorageKey,
      extractedEnvelope.body,
      {
        contentType: "application/octet-stream",
        retention: "audit-manifest",
        sha256: extractedEnvelope.plaintextSha256,
      },
    );
  } catch (error) {
    await storage.delete(input.tenant.organizationId, rawStorageKey);
    throw error;
  }

  const now = new Date().toISOString();
  try {
    await getD1().batch([
      getD1()
        .prepare(
          `INSERT INTO source_artifacts (
            id, organization_id, campaign_id, migration_spec_id,
            title, source_kind, media_type, storage_key, sha256,
            encryption_key_id, extracted_storage_key, extracted_sha256,
            extracted_encryption_key_id, extraction_status,
            extraction_message, page_count, external_url, size_bytes,
            uploaded_by_membership_id
          ) VALUES (
            ?, ?, ?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )`,
        )
        .bind(
          artifactId,
          input.tenant.organizationId,
          campaign.id,
          title,
          input.artifact.kind,
          input.artifact.mediaType,
          rawStorageKey,
          sourceSha256,
          rawEnvelope.encryptionKeyId,
          extractedStorageKey,
          extractedEnvelope.plaintextSha256,
          extractedEnvelope.encryptionKeyId,
          extracted.status,
          extracted.message ?? null,
          extracted.pageCount ?? null,
          input.artifact.externalUrl ?? null,
          input.artifact.bytes.byteLength,
          input.tenant.membershipId,
        ),
      getD1()
        .prepare(
          `UPDATE campaigns
           SET status = CASE WHEN status = 'draft'
                             THEN 'internal_authoring' ELSE status END,
               updated_at = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .bind(now, campaign.id, input.tenant.organizationId),
    ]);
  } catch (error) {
    await Promise.allSettled([
      storage.delete(input.tenant.organizationId, rawStorageKey),
      storage.delete(input.tenant.organizationId, extractedStorageKey),
    ]);
    throw error;
  }

  await appendAuditEvent({
    organizationId: input.tenant.organizationId,
    aggregateType: "campaign",
    aggregateId: campaign.id,
    action: "provider_artifact.stored",
    actorMembershipId: input.tenant.membershipId,
    payload: {
      artifactId,
      kind: input.artifact.kind,
      sourceSha256,
      sizeBytes: input.artifact.bytes.byteLength,
      extractionStatus: extracted.status,
      external: Boolean(input.artifact.externalUrl),
    },
  });

  return {
    id: artifactId,
    campaignId: campaign.id,
    migrationSpecId: null,
    title,
    kind: input.artifact.kind,
    mediaType: input.artifact.mediaType,
    sha256: sourceSha256,
    externalUrl: input.artifact.externalUrl ?? null,
    sizeBytes: input.artifact.bytes.byteLength,
    extractionStatus: extracted.status,
    extractionMessage: extracted.message ?? null,
    pageCount: extracted.pageCount ?? null,
    preview: extracted.text.slice(0, 1_200),
    createdAt: now,
  };
}

export async function uploadProviderArtifact(input: {
  tenant: TenantContext;
  campaignId: string;
  title: string;
  kind: ProviderArtifactKind;
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
}): Promise<ProviderSourceArtifact> {
  await ensureDatabaseSchema();
  assertProviderAuthor(input.tenant);
  return storeAcquiredArtifact({
    tenant: input.tenant,
    campaignId: input.campaignId,
    title: input.title,
    artifact: acquireUploadedProviderArtifact({
      fileName: input.fileName,
      mediaType: input.mediaType,
      bytes: input.bytes,
      kind: input.kind,
    }),
  });
}

export async function acquireProviderArtifact(input: {
  tenant: TenantContext;
  campaignId: string;
  title: string;
  kind: ProviderArtifactKind;
  url: string;
}): Promise<ProviderSourceArtifact> {
  await ensureDatabaseSchema();
  assertProviderAuthor(input.tenant);
  const artifact = await acquireProviderArtifactUrl({
    url: input.url,
    kind: input.kind,
  });
  return storeAcquiredArtifact({
    tenant: input.tenant,
    campaignId: input.campaignId,
    title: input.title,
    artifact,
  });
}

export async function listProviderArtifacts(
  organizationId: string,
  campaignId?: string,
): Promise<ProviderSourceArtifact[]> {
  await ensureDatabaseSchema();
  const result = await getD1()
    .prepare(
      `SELECT
         id,
         campaign_id AS campaignId,
         migration_spec_id AS migrationSpecId,
         title,
         source_kind AS kind,
         media_type AS mediaType,
         sha256,
         external_url AS externalUrl,
         size_bytes AS sizeBytes,
         extraction_status AS extractionStatus,
         extraction_message AS extractionMessage,
         page_count AS pageCount,
         extracted_storage_key AS extractedStorageKey,
         extracted_sha256 AS extractedSha256,
         extracted_encryption_key_id AS extractedEncryptionKeyId,
         created_at AS createdAt
       FROM source_artifacts
       WHERE organization_id = ?
         AND (? IS NULL OR campaign_id = ?)
       ORDER BY created_at DESC
       LIMIT 100`,
    )
    .bind(organizationId, campaignId ?? null, campaignId ?? null)
    .all<
      Omit<ProviderSourceArtifact, "preview"> & {
        extractedStorageKey: string | null;
        extractedSha256: string | null;
        extractedEncryptionKeyId: string | null;
      }
    >();
  const storage = new R2ArtifactStore();
  return Promise.all(
    result.results.map(async (artifact) => {
      let preview: string | null = null;
      if (
        artifact.extractionStatus === "complete" &&
        artifact.extractedStorageKey &&
        artifact.extractedSha256 &&
        artifact.extractedEncryptionKeyId
      ) {
        try {
          const object = await storage.get(
            organizationId,
            artifact.extractedStorageKey,
          );
          if (object) {
            preview = (
              await decryptArtifact({
                body: await object.arrayBuffer(),
                expectedKeyId: artifact.extractedEncryptionKeyId,
                expectedPlaintextSha256: artifact.extractedSha256,
              })
            ).slice(0, 1_200);
          }
        } catch {
          preview = null;
        }
      }
      const publicArtifact: Omit<ProviderSourceArtifact, "preview"> = {
        id: artifact.id,
        campaignId: artifact.campaignId,
        migrationSpecId: artifact.migrationSpecId,
        title: artifact.title,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        sha256: artifact.sha256,
        externalUrl: artifact.externalUrl,
        sizeBytes: artifact.sizeBytes,
        extractionStatus: artifact.extractionStatus,
        extractionMessage: artifact.extractionMessage,
        pageCount: artifact.pageCount,
        createdAt: artifact.createdAt,
      };
      return { ...publicArtifact, preview };
    }),
  );
}
