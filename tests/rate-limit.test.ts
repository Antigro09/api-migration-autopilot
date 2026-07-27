import assert from "node:assert/strict";
import test from "node:test";
import { resetControlPlane, testDatabase } from "./support/runtime";

const { deleteExpiredRateLimits, enforceRateLimit } = await import(
  "@/lib/security/rate-limit"
);

test.beforeEach(() => {
  resetControlPlane();
});

test("rate limits are isolated by opaque subject and operation", async () => {
  const now = new Date("2026-07-26T12:00:05.000Z");
  const first = await enforceRateLimit({
    subject: "membership-a",
    operation: "patch.request",
    limit: 2,
    windowSeconds: 60,
    now,
  });
  assert.equal(first.remaining, 1);
  assert.equal(
    (
      await enforceRateLimit({
        subject: "membership-a",
        operation: "patch.request",
        limit: 2,
        windowSeconds: 60,
        now,
      })
    ).remaining,
    0,
  );
  await assert.rejects(
    enforceRateLimit({
      subject: "membership-a",
      operation: "patch.request",
      limit: 2,
      windowSeconds: 60,
      now,
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "RATE_LIMITED" &&
      (error as { details?: { retryAfterSeconds?: number } }).details
        ?.retryAfterSeconds === 55,
  );

  assert.equal(
    (
      await enforceRateLimit({
        subject: "membership-b",
        operation: "patch.request",
        limit: 2,
        windowSeconds: 60,
        now,
      })
    ).remaining,
    1,
  );
  assert.equal(
    (
      await enforceRateLimit({
        subject: "membership-a",
        operation: "assessment.request",
        limit: 2,
        windowSeconds: 60,
        now,
      })
    ).remaining,
    1,
  );

  const persisted = testDatabase.sqlite
    .prepare("SELECT scope_hash AS scopeHash FROM rate_limit_buckets LIMIT 1")
    .get() as { scopeHash: string };
  assert.match(persisted.scopeHash, /^[a-f0-9]{64}$/);
  assert.notEqual(persisted.scopeHash, "membership-a");
});

test("expired rate-limit buckets are removed", async () => {
  await enforceRateLimit({
    subject: "membership-a",
    operation: "patch.request",
    limit: 2,
    windowSeconds: 60,
    now: new Date("2026-07-26T12:00:05.000Z"),
  });
  assert.equal(
    await deleteExpiredRateLimits(new Date("2026-07-26T12:02:01.000Z")),
    1,
  );
});
