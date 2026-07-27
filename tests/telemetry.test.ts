import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { resetControlPlane } from "./support/runtime";

const { getD1 } = await import("@/db");
const {
  changeOperationalAlert,
  listOperationalAlerts,
  recordOperationalAlert,
} = await import("@/lib/data/alerts");
const {
  emitTelemetry,
  sanitizeTelemetryEvent,
  sanitizeTelemetryMetadata,
  TelemetryPolicyError,
} = await import("@/lib/telemetry");
const { seedTenant } = await import("./support/factory");

beforeEach(() => {
  resetControlPlane();
});

test("telemetry allows only operational metadata and one-way hashes opaque IDs", async () => {
  const event = await sanitizeTelemetryEvent({
    name: "workflow.failed",
    organizationId: "org_customer_private",
    runId: "run_private",
    correlationId: "delivery-private",
    salt: "0123456789abcdef0123456789abcdef",
    environment: "test",
    release: "0.5.0-alpha.1",
    now: new Date("2026-07-26T12:00:00.000Z"),
    metadata: {
      run_kind: "patch",
      failure_category: "infrastructure",
      retry_count: 2,
      duration_ms: 4_200,
      severity: "critical",
      outcome: "failed",
    },
  });
  assert.equal(event.name, "workflow.failed");
  assert.match(event.organizationHash ?? "", /^org_[a-f0-9]{32}$/);
  assert.match(event.runHash ?? "", /^run_[a-f0-9]{32}$/);
  assert.match(event.correlationHash ?? "", /^cor_[a-f0-9]{32}$/);
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes("org_customer_private"));
  assert.ok(!serialized.includes("run_private"));
  assert.ok(!serialized.includes("delivery-private"));
});

test("telemetry policy rejects source-bearing, credential, identity, and unknown fields", () => {
  for (const key of [
    "source",
    "snippet",
    "diff",
    "repository_path",
    "filename",
    "validation_log",
    "token",
    "signed_url",
    "email",
    "request_body",
    "repository_name",
  ]) {
    assert.throws(
      () => sanitizeTelemetryMetadata({ [key]: "private" }),
      TelemetryPolicyError,
      key,
    );
  }
  assert.throws(
    () => sanitizeTelemetryMetadata({ operation: "src/private.ts" }),
    TelemetryPolicyError,
  );
});

test("configured telemetry sends the same sanitized event to OTLP, Sentry, and PostHog", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const delivery = await emitTelemetry(
    {
      name: "workflow.completed",
      organizationId: "org_never_export_raw",
      runId: "run_never_export_raw",
      metadata: {
        run_kind: "assessment",
        duration_ms: 1_250,
        cost_micro_usd: 42,
        outcome: "succeeded",
      },
    },
    {
      env: {
        NODE_ENV: "test",
        TELEMETRY_HASH_SALT: "0123456789abcdef0123456789abcdef",
        APP_ENV: "test",
        APP_RELEASE: "0.5.0-alpha.1",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test",
        OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=otel-secret",
        SENTRY_DSN: "https://public-key@o1.ingest.sentry.io/123",
        POSTHOG_API_KEY: "phc_test",
        POSTHOG_HOST: "https://us.i.posthog.com",
      },
      fetcher: async (input, init) => {
        requests.push({
          url: String(input),
          body: String(init?.body ?? ""),
        });
        return new Response(null, { status: 200 });
      },
    },
  );
  assert.deepEqual(delivery.delivered.sort(), [
    "opentelemetry",
    "posthog",
    "sentry",
  ]);
  assert.equal(delivery.failed.length, 0);
  assert.equal(requests.length, 3);
  assert.ok(requests.some((request) => request.url.endsWith("/v1/logs")));
  assert.ok(requests.some((request) => request.url.includes("/envelope/")));
  assert.ok(requests.some((request) => request.url.endsWith("/capture/")));
  const bodies = requests.map((request) => request.body).join("\n");
  assert.ok(!bodies.includes("org_never_export_raw"));
  assert.ok(!bodies.includes("run_never_export_raw"));
  assert.ok(bodies.includes("workflow.completed"));
});

test("operational alerts deduplicate, acknowledge, resolve, and retain only redacted codes", async () => {
  const tenant = await seedTenant();
  const internalOrganizationId = "org_internal_alerts";
  const internalMembershipId = "mem_internal_alerts";
  await getD1().batch([
    getD1()
      .prepare(
        "INSERT INTO organizations (id, workos_organization_id, name, kind) VALUES (?, ?, 'Autopilot Alerts', 'internal')",
      )
      .bind(internalOrganizationId, "siwc:internal-alerts"),
    getD1()
      .prepare(
        "INSERT INTO memberships (id, organization_id, workos_user_id, role, status) VALUES (?, ?, 'siwc:alert-operator', 'operator', 'active')",
      )
      .bind(internalMembershipId, internalOrganizationId),
  ]);
  const operator = {
    organizationId: internalOrganizationId,
    membershipId: internalMembershipId,
    userId: "alert-operator",
    role: "operator",
    organizationKind: "internal",
  } as const;
  const first = await recordOperationalAlert({
    organizationId: tenant.customerOrganizationId,
    runId: tenant.assessmentRunId,
    severity: "critical",
    code: "workflow.assessment_failed",
    eventName: "workflow.failed",
    metadata: {
      run_kind: "assessment",
      failure_category: "infrastructure",
      outcome: "failed",
    },
  });
  const second = await recordOperationalAlert({
    organizationId: tenant.customerOrganizationId,
    runId: tenant.assessmentRunId,
    severity: "critical",
    code: "workflow.assessment_failed",
    eventName: "workflow.failed",
    metadata: {
      run_kind: "assessment",
      failure_category: "infrastructure",
      outcome: "failed",
    },
  });
  assert.equal(second.alertId, first.alertId);
  let alerts = await listOperationalAlerts(operator);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.occurrenceCount, 2);
  assert.equal(alerts[0]?.code, "workflow.assessment_failed");

  await changeOperationalAlert({
    tenant: operator,
    alertId: first.alertId,
    action: "acknowledge",
  });
  alerts = await listOperationalAlerts(operator);
  assert.equal(alerts[0]?.status, "acknowledged");
  await changeOperationalAlert({
    tenant: operator,
    alertId: first.alertId,
    action: "resolve",
  });
  alerts = await listOperationalAlerts(operator);
  assert.equal(alerts.length, 0);
});
