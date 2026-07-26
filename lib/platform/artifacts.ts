import { env } from "cloudflare:workers";

export type ArtifactRetention = "run-source" | "customer-review" | "audit-manifest";

export type StoredArtifact = {
  key: string;
  etag: string;
  size: number;
  uploadedAt: Date;
};

export interface ArtifactStore {
  put(
    tenantId: string,
    key: string,
    body: ArrayBuffer | ArrayBufferView | Blob | string,
    options: {
      contentType: string;
      retention: ArtifactRetention;
      sha256: string;
    },
  ): Promise<StoredArtifact>;
  get(tenantId: string, key: string): Promise<R2ObjectBody | null>;
  delete(tenantId: string, key: string): Promise<void>;
  deletePrefix(tenantId: string, prefix: string): Promise<number>;
}

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,511}$/;

function scopedKey(tenantId: string, key: string): string {
  if (!SAFE_SEGMENT.test(tenantId) || !SAFE_SEGMENT.test(key)) {
    throw new Error("Artifact keys may contain only safe path characters.");
  }
  if (
    tenantId.includes("..") ||
    key.includes("..") ||
    key.startsWith("/") ||
    key.includes("\\")
  ) {
    throw new Error("Artifact key traversal is not allowed.");
  }
  return `tenants/${tenantId}/${key}`;
}

function artifactBucket(): R2Bucket {
  if (!env.ARTIFACTS) {
    throw new Error(
      "Cloudflare R2 binding `ARTIFACTS` is unavailable. Configure the r2 binding before storing artifacts.",
    );
  }
  return env.ARTIFACTS;
}

export class R2ArtifactStore implements ArtifactStore {
  async put(
    tenantId: string,
    key: string,
    body: ArrayBuffer | ArrayBufferView | Blob | string,
    options: {
      contentType: string;
      retention: ArtifactRetention;
      sha256: string;
    },
  ): Promise<StoredArtifact> {
    const object = await artifactBucket().put(scopedKey(tenantId, key), body, {
      httpMetadata: { contentType: options.contentType },
      customMetadata: {
        retention: options.retention,
        sha256: options.sha256,
      },
    });

    if (!object) {
      throw new Error("Artifact storage did not return an object record.");
    }

    return {
      key,
      etag: object.etag,
      size: object.size,
      uploadedAt: object.uploaded,
    };
  }

  get(tenantId: string, key: string): Promise<R2ObjectBody | null> {
    return artifactBucket().get(scopedKey(tenantId, key));
  }

  async delete(tenantId: string, key: string): Promise<void> {
    await artifactBucket().delete(scopedKey(tenantId, key));
  }

  async deletePrefix(tenantId: string, prefix: string): Promise<number> {
    const fullPrefix = scopedKey(tenantId, prefix);
    let cursor: string | undefined;
    let deleted = 0;

    do {
      const page = await artifactBucket().list({ prefix: fullPrefix, cursor });
      if (page.objects.length > 0) {
        await artifactBucket().delete(page.objects.map((object) => object.key));
        deleted += page.objects.length;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    return deleted;
  }
}
