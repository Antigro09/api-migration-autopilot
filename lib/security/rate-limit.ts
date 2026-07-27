import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import { DomainError } from "@/lib/domain/errors";

const encoder = new TextEncoder();

async function scopeDigest(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(subject));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function enforceRateLimit(input: {
  subject: string;
  operation: string;
  limit: number;
  windowSeconds: number;
  now?: Date;
}): Promise<{ remaining: number; retryAfterSeconds: number }> {
  if (
    !input.subject ||
    !/^[a-z][a-z0-9._-]{1,63}$/.test(input.operation) ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 10_000 ||
    !Number.isInteger(input.windowSeconds) ||
    input.windowSeconds < 1 ||
    input.windowSeconds > 86_400
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "The request limit policy is invalid.",
    );
  }
  await ensureDatabaseSchema();
  const now = input.now ?? new Date();
  const windowMs = input.windowSeconds * 1_000;
  const windowStartedAtMs = Math.floor(now.getTime() / windowMs) * windowMs;
  const windowStartedAt = new Date(windowStartedAtMs).toISOString();
  const expiresAt = new Date(windowStartedAtMs + windowMs * 2).toISOString();
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowStartedAtMs + windowMs - now.getTime()) / 1_000),
  );
  const scopeHash = await scopeDigest(input.subject);

  const row = await getD1()
    .prepare(
      `INSERT INTO rate_limit_buckets (
         scope_hash, operation, window_started_at, request_count, expires_at
       ) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (scope_hash, operation, window_started_at)
       DO UPDATE SET request_count = request_count + 1
       RETURNING request_count AS requestCount`,
    )
    .bind(
      scopeHash,
      input.operation,
      windowStartedAt,
      expiresAt,
    )
    .first<{ requestCount: number }>();
  const count = Number(row?.requestCount ?? input.limit + 1);
  if (count > input.limit) {
    throw new DomainError(
      "RATE_LIMITED",
      "Too many requests. Wait briefly and try again.",
      { retryAfterSeconds },
    );
  }
  return {
    remaining: Math.max(0, input.limit - count),
    retryAfterSeconds,
  };
}

export async function deleteExpiredRateLimits(now = new Date()): Promise<number> {
  await ensureDatabaseSchema();
  const result = await getD1()
    .prepare("DELETE FROM rate_limit_buckets WHERE expires_at <= ?")
    .bind(now.toISOString())
    .run();
  return Number(result.meta.changes ?? 0);
}

