import assert from "node:assert/strict";
import test from "node:test";
import { resetControlPlane, testBucket } from "./support/runtime";

const { getD1 } = await import("@/db");
const {
  bootstrapOrganization,
  createCampaign,
  getCampaign,
} = await import("@/lib/data/control-plane");
const {
  uploadProviderArtifact,
  listProviderArtifacts,
} = await import("@/lib/data/provider-artifacts");
const {
  saveProviderRule,
  submitProviderSpecForReview,
} = await import("@/lib/data/provider-spec-authoring");
const {
  approveMigrationSpec,
  launchCampaign,
  transitionCampaign,
} = await import("@/lib/data/specs");
const {
  beginProviderDomainVerification,
  verifyProviderDomain,
} = await import("@/lib/data/provider-verification");
const {
  approveProviderBranding,
  operationsOverview,
} = await import("@/lib/data/operations");
const {
  acquireProviderArtifactUrl,
  extractProviderArtifact,
  validatePublicArtifactUrl,
} = await import("@/lib/provider/artifact-intake");
const { DomainError } = await import("@/lib/domain/errors");

test.beforeEach(() => {
  resetControlPlane();
});

async function providerFixture(label = "Provider") {
  const workspace = await bootstrapOrganization({
    actorId: `actor-${label}`,
    name: `${label} Inc`,
    kind: "provider",
  });
  const tenant = {
    organizationId: workspace.organizationId,
    membershipId: workspace.membershipId,
    userId: `actor-${label}`,
    role: workspace.role,
    organizationKind: workspace.kind,
  } as const;
  const campaign = await createCampaign(tenant, {
    productName: `${label} SDK`,
    packageName: `@${label.toLowerCase()}/sdk`,
    sourceRange: ">=1 <2",
    targetVersion: "2.0.0",
    notes: "Upgrade the supported Node SDK.",
  });
  return { workspace, tenant, campaign };
}

async function expectCode(
  promise: Promise<unknown>,
  code: InstanceType<typeof DomainError>["code"],
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    return true;
  });
}

test("artifact intake rejects private destinations and unsafe DNS answers", async () => {
  assert.throws(
    () => validatePublicArtifactUrl("https://127.0.0.1/guide"),
    (error: unknown) =>
      error instanceof DomainError && error.code === "FORBIDDEN",
  );
  assert.throws(
    () => validatePublicArtifactUrl("http://docs.example.com/guide"),
    (error: unknown) =>
      error instanceof DomainError && error.code === "VALIDATION_FAILED",
  );

  const unsafeDns: typeof fetch = async (request) => {
    const url = new URL(String(request));
    if (url.hostname === "cloudflare-dns.com") {
      const type = url.searchParams.get("type");
      return Response.json({
        Status: 0,
        Answer:
          type === "A"
            ? [{ type: 1, data: "10.1.2.3" }]
            : [],
      });
    }
    throw new Error("The content endpoint must never be reached.");
  };
  await expectCode(
    acquireProviderArtifactUrl({
      url: "https://docs.example.com/guide",
      kind: "markdown",
      fetcher: unsafeDns,
    }),
    "FORBIDDEN",
  );
});

test("HTML, YAML, and OpenAPI evidence are parsed without active content", async () => {
  const html = await extractProviderArtifact({
    kind: "html",
    mediaType: "text/html",
    bytes: new TextEncoder().encode(
      "<main>Migration guide<script>private()</script><h1>Upgrade</h1></main>",
    ),
  });
  assert.match(html.text, /Migration guide/);
  assert.match(html.text, /Upgrade/);
  assert.doesNotMatch(html.text, /private/);

  const yaml = await extractProviderArtifact({
    kind: "yaml",
    mediaType: "application/yaml",
    bytes: new TextEncoder().encode("version: 2\nchanges:\n  - rename"),
  });
  assert.match(yaml.text, /"version": 2/);

  const openapi = await extractProviderArtifact({
    kind: "openapi",
    mediaType: "application/json",
    bytes: new TextEncoder().encode(
      JSON.stringify({ openapi: "3.1.0", paths: {} }),
    ),
  });
  assert.match(openapi.text, /3\.1\.0/);
});

test("a provider authors, submits, approves, launches, and safely revises a real spec", async () => {
  const fixture = await providerFixture();
  const source = "# Upgrade\nReplace `oldClient()` with `new Client()`.";
  const artifact = await uploadProviderArtifact({
    tenant: fixture.tenant,
    campaignId: fixture.campaign.id,
    title: "Version 2 migration guide",
    kind: "markdown",
    fileName: "migration.md",
    mediaType: "text/markdown",
    bytes: new TextEncoder().encode(source),
  });
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await listProviderArtifacts(
    fixture.workspace.organizationId,
    fixture.campaign.id,
  ))[0]?.preview, source);
  const stored = [...testBucket.objects.values()];
  assert.equal(stored.length, 2);
  assert.equal(
    stored.some((object) =>
      new TextDecoder().decode(object.body).includes("oldClient"),
    ),
    false,
  );

  const revision1 = await saveProviderRule({
    tenant: fixture.tenant,
    rule: {
      campaignId: fixture.campaign.id,
      id: "SDK-CONSTRUCTOR-01",
      title: "Construct the v2 client",
      description: "The v2 SDK exports a class constructor.",
      severity: "breaking",
      artifactId: artifact.id,
      locator: "Upgrade",
      excerpt: "Replace oldClient() with new Client().",
      detectorKind: "call_expression",
      moduleName: fixture.campaign.packageName,
      symbol: "oldClient",
      transformationKind: "parameterized_template",
      beforeExample: "const client = oldClient(key)",
      afterExample: "const client = new Client(key)",
      rationale: "Preserve the existing key while changing construction.",
      autoPatchEligible: true,
      behavioralInvariants: ["The same credential value is passed."],
      validationHints: ["Run the repository type-check."],
      knownLimitations: ["Aliased wrappers require manual review."],
      generalLimitations: ["Dynamic imports are reported as partial coverage."],
    },
  });
  await expectCode(
    approveMigrationSpec({
      tenant: fixture.tenant,
      campaignId: fixture.campaign.id,
      specId: revision1.specId,
      expectedContentSha256: revision1.contentSha256,
    }),
    "INVALID_STATE_TRANSITION",
  );
  await submitProviderSpecForReview({
    tenant: fixture.tenant,
    campaignId: fixture.campaign.id,
    specId: revision1.specId,
    expectedContentSha256: revision1.contentSha256,
  });
  await approveMigrationSpec({
    tenant: fixture.tenant,
    campaignId: fixture.campaign.id,
    specId: revision1.specId,
    expectedContentSha256: revision1.contentSha256,
  });
  await launchCampaign({
    tenant: fixture.tenant,
    campaignId: fixture.campaign.id,
  });
  assert.equal(
    (await getCampaign(
      fixture.workspace.organizationId,
      fixture.campaign.id,
    ))?.status,
    "live",
  );

  const revision2 = await saveProviderRule({
    tenant: fixture.tenant,
    rule: {
      campaignId: fixture.campaign.id,
      id: "SDK-TYPE-02",
      title: "Rename the request type",
      description: "The request type was renamed in v2.",
      severity: "high",
      artifactId: artifact.id,
      locator: "Upgrade",
      detectorKind: "symbol_reference",
      moduleName: fixture.campaign.packageName,
      symbol: "LegacyRequest",
      transformationKind: "model_residual",
      beforeExample: "LegacyRequest",
      afterExample: "CurrentRequest",
      rationale: "Resolve aliases within an approved file boundary.",
      autoPatchEligible: true,
      behavioralInvariants: ["Request values remain structurally equivalent."],
      validationHints: ["Run the TypeScript compiler."],
      knownLimitations: ["Generated types are not edited."],
      generalLimitations: [],
    },
  });
  assert.equal(revision2.revision, 2);
  const pinned = await getCampaign(
    fixture.workspace.organizationId,
    fixture.campaign.id,
  );
  assert.equal(pinned?.status, "live");
  assert.equal(pinned?.currentSpecId, revision1.specId);

  await submitProviderSpecForReview({
    tenant: fixture.tenant,
    campaignId: fixture.campaign.id,
    specId: revision2.specId,
    expectedContentSha256: revision2.contentSha256,
  });
  await approveMigrationSpec({
    tenant: fixture.tenant,
    campaignId: fixture.campaign.id,
    specId: revision2.specId,
    expectedContentSha256: revision2.contentSha256,
  });
  const revised = await getCampaign(
    fixture.workspace.organizationId,
    fixture.campaign.id,
  );
  assert.equal(revised?.status, "live");
  assert.equal(revised?.currentSpecId, revision2.specId);
  const old = await getD1()
    .prepare("SELECT status FROM migration_specs WHERE id = ?")
    .bind(revision1.specId)
    .first<{ status: string }>();
  assert.equal(old?.status, "superseded");

  await transitionCampaign({
    tenant: fixture.tenant,
    campaignId: fixture.campaign.id,
    target: "paused",
  });
  assert.equal(
    (await getCampaign(
      fixture.workspace.organizationId,
      fixture.campaign.id,
    ))?.status,
    "paused",
  );
});

test("provider evidence cannot be cited across organizations", async () => {
  const first = await providerFixture("First");
  const second = await providerFixture("Second");
  const firstArtifact = await uploadProviderArtifact({
    tenant: first.tenant,
    campaignId: first.campaign.id,
    title: "First guide",
    kind: "markdown",
    fileName: "first.md",
    mediaType: "text/markdown",
    bytes: new TextEncoder().encode("# First"),
  });
  await uploadProviderArtifact({
    tenant: second.tenant,
    campaignId: second.campaign.id,
    title: "Second guide",
    kind: "markdown",
    fileName: "second.md",
    mediaType: "text/markdown",
    bytes: new TextEncoder().encode("# Second"),
  });
  await expectCode(
    saveProviderRule({
      tenant: second.tenant,
      rule: {
        campaignId: second.campaign.id,
        id: "CROSS-TENANT",
        title: "Invalid citation",
        description: "This citation belongs to another tenant.",
        severity: "breaking",
        artifactId: firstArtifact.id,
        locator: "First",
        detectorKind: "import",
        moduleName: second.campaign.packageName,
        transformationKind: "manual",
        autoPatchEligible: false,
        behavioralInvariants: ["No behavior change."],
        validationHints: ["Review manually."],
        knownLimitations: ["Not automatable."],
        generalLimitations: [],
      },
    }),
    "VALIDATION_FAILED",
  );
});

test("provider DNS verification requires the exact persisted TXT value", async () => {
  const fixture = await providerFixture();
  const challenge = await beginProviderDomainVerification({
    tenant: fixture.tenant,
    domain: "provider.example",
  });
  await expectCode(
    verifyProviderDomain({
      tenant: fixture.tenant,
      challengeId: challenge.id,
      resolver: async () => ["wrong-value"],
    }),
    "VALIDATION_FAILED",
  );
  const verified = await verifyProviderDomain({
    tenant: fixture.tenant,
    challengeId: challenge.id,
    resolver: async (name) => {
      assert.equal(name, challenge.dnsName);
      return [challenge.verificationValue];
    },
  });
  assert.equal(verified.verifiedDomain, "provider.example");
  const organization = await getD1()
    .prepare("SELECT verified_domain AS domain FROM organizations WHERE id = ?")
    .bind(fixture.workspace.organizationId)
    .first<{ domain: string }>();
  assert.equal(organization?.domain, "provider.example");
});

test("internal branding approval requires verified ownership and uses persisted counts", async () => {
  const fixture = await providerFixture();
  const internalOrganizationId = "org_internal";
  const internalMembershipId = "mem_internal";
  await getD1().batch([
    getD1()
      .prepare(
        "INSERT INTO organizations (id, workos_organization_id, name, kind) VALUES (?, ?, 'Autopilot Operations', 'internal')",
      )
      .bind(internalOrganizationId, "siwc:internal"),
    getD1()
      .prepare(
        "INSERT INTO memberships (id, organization_id, workos_user_id, role, status) VALUES (?, ?, 'siwc:operator', 'operator', 'active')",
      )
      .bind(internalMembershipId, internalOrganizationId),
  ]);
  const operator = {
    organizationId: internalOrganizationId,
    membershipId: internalMembershipId,
    userId: "operator",
    role: "operator",
    organizationKind: "internal",
  } as const;
  await expectCode(
    approveProviderBranding({
      tenant: operator,
      providerOrganizationId: fixture.workspace.organizationId,
    }),
    "INVALID_STATE_TRANSITION",
  );
  const challenge = await beginProviderDomainVerification({
    tenant: fixture.tenant,
    domain: "verified.example",
  });
  await verifyProviderDomain({
    tenant: fixture.tenant,
    challengeId: challenge.id,
    resolver: async () => [challenge.verificationValue],
  });
  const before = await operationsOverview(operator);
  assert.equal(before.unverifiedProviders, 1);
  await approveProviderBranding({
    tenant: operator,
    providerOrganizationId: fixture.workspace.organizationId,
  });
  const after = await operationsOverview(operator);
  assert.equal(after.unverifiedProviders, 0);
  assert.ok(after.providers[0]?.brandingApprovedAt);
  assert.equal(
    after.recentAuditEvents[0]?.action,
    "provider_branding.approved",
  );
});
