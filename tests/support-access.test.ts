import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { resetControlPlane } from "./support/runtime";

const { getD1 } = await import("@/db");
const { storeRunArtifact } = await import("@/lib/data/artifacts");
const {
  customerSupportAccess,
  operationsSupportAccess,
  readSupportArtifact,
  requestSupportAccess,
  resolveSupportAccessRequest,
  revokeSupportAccessGrant,
} = await import("@/lib/data/support");
const { seedTenant } = await import("./support/factory");

beforeEach(() => {
  resetControlPlane();
});

async function internalOperator(suffix = "primary") {
  const organizationId = `org_internal_support_${suffix}`;
  const membershipId = `mem_internal_support_${suffix}`;
  await getD1().batch([
    getD1()
      .prepare(
        "INSERT INTO organizations (id, workos_organization_id, name, kind) VALUES (?, ?, 'Autopilot Support', 'internal')",
      )
      .bind(organizationId, `siwc:internal-support-${suffix}`),
    getD1()
      .prepare(
        "INSERT INTO memberships (id, organization_id, workos_user_id, role, status) VALUES (?, ?, ?, 'operator', 'active')",
      )
      .bind(
        membershipId,
        organizationId,
        `siwc:internal-support-user-${suffix}`,
      ),
  ]);
  return {
    organizationId,
    membershipId,
    userId: `internal-support-${suffix}`,
    role: "operator",
    organizationKind: "internal",
  } as const;
}

test("support access is customer-approved, exact-run scoped, expiring, and read-audited", async () => {
  const tenant = await seedTenant();
  const operator = await internalOperator();
  const stored = await storeRunArtifact({
    organizationId: tenant.customerOrganizationId,
    runId: tenant.assessmentRunId,
    campaignId: tenant.campaignId,
    kind: "validation_log",
    storageKey: `runs/${tenant.assessmentRunId}/support-test.log`,
    plaintext: "customer-only validation output",
    contentType: "text/plain",
  });

  const requested = await requestSupportAccess({
    tenant: operator,
    runId: tenant.assessmentRunId,
    reason: "Investigate a customer-reported validation infrastructure failure.",
    durationMinutes: 60,
  });
  const customerBefore = await customerSupportAccess(
    tenant.customerOrganizationId,
  );
  assert.equal(customerBefore.requests[0]?.id, requested.requestId);
  assert.equal(customerBefore.requests[0]?.status, "pending");
  assert.equal(customerBefore.grants.length, 0);

  const approved = await resolveSupportAccessRequest({
    tenant: tenant.tenantFor("approver"),
    requestId: requested.requestId,
    decision: "approve",
  });
  assert.ok(approved.grantId);
  const operations = await operationsSupportAccess(operator);
  assert.equal(operations.activeGrantCount, 1);
  assert.equal(operations.artifacts.length, 1);
  assert.equal(operations.artifacts[0]?.artifactId, stored.id);

  const read = await readSupportArtifact({
    tenant: operator,
    artifactId: stored.id,
  });
  assert.equal(read.plaintext, "customer-only validation output");
  assert.equal(read.kind, "validation_log");
  const reads = await getD1()
    .prepare(
      `SELECT COUNT(*) AS count
       FROM audit_events
       WHERE organization_id = ? AND aggregate_type = 'support_grant'
         AND aggregate_id = ? AND action = 'support.artifact_read'`,
    )
    .bind(tenant.customerOrganizationId, approved.grantId)
    .first<{ count: number }>();
  assert.equal(reads?.count, 1);

  await revokeSupportAccessGrant({
    tenant: tenant.tenantFor("admin"),
    grantId: approved.grantId as string,
  });
  await assert.rejects(
    readSupportArtifact({ tenant: operator, artifactId: stored.id }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("No active customer grant"),
  );
});

test("a different customer cannot resolve or revoke another tenant's support access", async () => {
  const owner = await seedTenant();
  const other = await seedTenant();
  const operator = await internalOperator("cross-tenant");
  const requested = await requestSupportAccess({
    tenant: operator,
    runId: owner.assessmentRunId,
    reason: "Investigate a customer-reported assessment infrastructure failure.",
    durationMinutes: 30,
  });

  await assert.rejects(
    resolveSupportAccessRequest({
      tenant: other.tenantFor("approver"),
      requestId: requested.requestId,
      decision: "approve",
    }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("not found"),
  );
  const approval = await resolveSupportAccessRequest({
    tenant: owner.tenantFor("approver"),
    requestId: requested.requestId,
    decision: "approve",
  });
  await assert.rejects(
    revokeSupportAccessGrant({
      tenant: other.tenantFor("admin"),
      grantId: approval.grantId as string,
    }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("not found"),
  );
});

test("expired grants fail closed even when an artifact remains retained", async () => {
  const tenant = await seedTenant();
  const operator = await internalOperator("expired");
  const stored = await storeRunArtifact({
    organizationId: tenant.customerOrganizationId,
    runId: tenant.assessmentRunId,
    kind: "affected_snippets",
    storageKey: `runs/${tenant.assessmentRunId}/expired-support.json`,
    plaintext: '{"snippet":"private"}',
    contentType: "application/json",
  });
  const requested = await requestSupportAccess({
    tenant: operator,
    runId: tenant.assessmentRunId,
    reason: "Investigate an unresolved model classification for the customer.",
    durationMinutes: 30,
  });
  const approved = await resolveSupportAccessRequest({
    tenant: tenant.tenantFor("admin"),
    requestId: requested.requestId,
    decision: "approve",
  });
  await getD1()
    .prepare("UPDATE support_access_grants SET expires_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - 1_000).toISOString(), approved.grantId)
    .run();

  await assert.rejects(
    readSupportArtifact({ tenant: operator, artifactId: stored.id }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("No active customer grant"),
  );
});
