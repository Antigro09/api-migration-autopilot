import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import type { ArtifactKind } from "@/lib/domain";
import { DomainError } from "@/lib/domain/errors";
import { decryptArtifact, encryptArtifact } from "@/lib/platform/encryption";
import {
  R2ArtifactStore,
  type ArtifactRetention,
  type ArtifactStore,
} from "@/lib/platform/artifacts";

export type StoredRunArtifact = {
  id: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  expiresAt: string;
};

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Retention windows enforced by the deletion sweeper. Source-derived material
 * has the shortest life; only audit manifests survive a year.
 */
export const RETENTION_WINDOW_MS: Record<ArtifactRetention, number> = {
  "run-source": DAY_MS,
  "customer-review": 30 * DAY_MS,
  "audit-manifest": 365 * DAY_MS,
};

export const RETENTION_FOR_KIND: Record<ArtifactKind, ArtifactRetention> = {
  provider_source: "audit-manifest",
  repository_archive: "run-source",
  affected_snippets: "run-source",
  patch: "customer-review",
  patch_file: "customer-review",
  validation_log: "customer-review",
  run_manifest: "audit-manifest",
};

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function store(): ArtifactStore {
  return new R2ArtifactStore();
}

/**
 * Encrypts, writes to object storage, then records the artifact. The database
 * row is written last so a crash never advertises an object that is absent.
 */
export async function storeRunArtifact(input: {
  organizationId: string;
  runId: string | null;
  campaignId?: string | null;
  kind: ArtifactKind;
  storageKey: string;
  plaintext: string;
  contentType: string;
  now?: Date;
}): Promise<StoredRunArtifact> {
  await ensureDatabaseSchema();
  const retention = RETENTION_FOR_KIND[input.kind];
  const envelope = await encryptArtifact(input.plaintext);
  const written = await store().put(
    input.organizationId,
    input.storageKey,
    envelope.body,
    {
      contentType: input.contentType,
      retention,
      sha256: envelope.plaintextSha256,
    },
  );

  const now = input.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + RETENTION_WINDOW_MS[retention],
  ).toISOString();
  const artifactId = id("art");
  await getD1()
    .prepare(
      `INSERT INTO artifacts (
        id, organization_id, run_id, campaign_id, kind, storage_key,
        sha256, size_bytes, encryption_key_id, lifecycle_state, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      ON CONFLICT(organization_id, storage_key) DO UPDATE SET
        sha256 = excluded.sha256,
        size_bytes = excluded.size_bytes,
        encryption_key_id = excluded.encryption_key_id,
        lifecycle_state = 'active',
        expires_at = excluded.expires_at,
        deleted_at = null,
        deletion_verified_at = null`,
    )
    .bind(
      artifactId,
      input.organizationId,
      input.runId,
      input.campaignId ?? null,
      input.kind,
      input.storageKey,
      envelope.plaintextSha256,
      written.size,
      envelope.encryptionKeyId,
      expiresAt,
    )
    .run();

  const persisted = await getD1()
    .prepare(
      `SELECT id, sha256, size_bytes AS sizeBytes, expires_at AS expiresAt
       FROM artifacts
       WHERE organization_id = ? AND storage_key = ?
       LIMIT 1`,
    )
    .bind(input.organizationId, input.storageKey)
    .first<{
      id: string;
      sha256: string;
      sizeBytes: number;
      expiresAt: string;
    }>();
  if (!persisted) {
    throw new Error("Artifact record was written but could not be reloaded.");
  }
  return {
    id: persisted.id,
    storageKey: input.storageKey,
    sha256: persisted.sha256,
    sizeBytes: persisted.sizeBytes,
    expiresAt: persisted.expiresAt,
  };
}

/**
 * Reads an artifact for the owning organization only. Expired, queued, or
 * deleted artifacts fail closed rather than returning stale plaintext.
 */
export async function readRunArtifact(input: {
  organizationId: string;
  artifactId: string;
}): Promise<string> {
  await ensureDatabaseSchema();
  const artifact = await getD1()
    .prepare(
      `SELECT
        storage_key AS storageKey,
        sha256,
        encryption_key_id AS encryptionKeyId,
        lifecycle_state AS lifecycleState,
        expires_at AS expiresAt
       FROM artifacts
       WHERE id = ? AND organization_id = ?
       LIMIT 1`,
    )
    .bind(input.artifactId, input.organizationId)
    .first<{
      storageKey: string;
      sha256: string;
      encryptionKeyId: string;
      lifecycleState: string;
      expiresAt: string | null;
    }>();
  if (!artifact) {
    throw new DomainError("NOT_FOUND", "The artifact was not found.");
  }
  if (artifact.lifecycleState !== "active") {
    throw new DomainError(
      "NOT_FOUND",
      "The artifact has been deleted under the retention policy.",
    );
  }
  if (artifact.expiresAt && Date.parse(artifact.expiresAt) <= Date.now()) {
    throw new DomainError(
      "NOT_FOUND",
      "The artifact has passed its retention window and is pending deletion.",
    );
  }
  const object = await store().get(input.organizationId, artifact.storageKey);
  if (!object) {
    throw new DomainError(
      "NOT_FOUND",
      "The artifact object is no longer present in storage.",
    );
  }
  return decryptArtifact({
    body: await object.arrayBuffer(),
    expectedKeyId: artifact.encryptionKeyId,
    expectedPlaintextSha256: artifact.sha256,
  });
}

export async function findRunArtifact(input: {
  organizationId: string;
  runId: string;
  kind: ArtifactKind;
}): Promise<{ id: string; sha256: string; sizeBytes: number } | null> {
  await ensureDatabaseSchema();
  return getD1()
    .prepare(
      `SELECT id, sha256, size_bytes AS sizeBytes
       FROM artifacts
       WHERE organization_id = ? AND run_id = ? AND kind = ?
         AND lifecycle_state = 'active'
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(input.organizationId, input.runId, input.kind)
    .first<{ id: string; sha256: string; sizeBytes: number }>();
}
