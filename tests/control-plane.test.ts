import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { resetControlPlane, testBucket } from "./support/runtime";

// Application modules reach for `cloudflare:workers`, which only resolves once
// the runtime hooks above are installed, so they are imported dynamically.
const { seedPatchRun, seedTenant } = await import("./support/factory");
const {
  assertModelProcessingAllowed,
  grantModelConsent,
  revokeModelConsent,
} = await import("@/lib/data/consent");
const {
  checkModelConsentForRun,
  listRunStages,
  patchWorkPacket,
  recordRunStage,
  requestPatch,
  submitPatchResult,
} = await import("@/lib/data/patches");
const { approvePatch, publishApprovedPatch, readPersistedPatch } = await import(
  "@/lib/data/publication"
);
const { customerPatchReview, customerWorkspaceData, runStatus } = await import(
  "@/lib/data/customer"
);
const { providerDashboard } = await import("@/lib/data/control-plane");
const { readRunArtifact, storeRunArtifact } = await import(
  "@/lib/data/artifacts"
);
const { sweepRetention } = await import("@/lib/data/retention");
const { MODEL_CONSENT_POLICY_VERSION } = await import("@/lib/domain");
const { createPatchHash } = await import("@/lib/migration/patch-security");
const { parsePatchRunResult } = await import(
  "@/lib/migration/patch-validation"
);
const { getD1 } = await import("@/db");

type SeededTenant = Awaited<ReturnType<typeof seedTenant>>;

const ORIGINAL = "const stripe = Stripe(process.env.KEY);\n";
const PATCHED = "const stripe = new Stripe(process.env.KEY);\n";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function buildPatchResult(
  tenant: SeededTenant,
  overrides?: {
    path?: string;
    newContent?: string;
    integrity?: Partial<Record<string, boolean>>;
    validationOutcome?: "passed" | "failed" | "incomplete";
  },
) {
  const path = overrides?.path ?? "src/billing.ts";
  const newContent = overrides?.newContent ?? PATCHED;
  const files = [
    {
      path,
      originalContent: ORIGINAL,
      newContent,
      ruleIds: ["stripe.constructor.new"],
      rationale: ["Instantiate the v22 ES class export with new."],
    },
  ];
  const outcome = overrides?.validationOutcome ?? "passed";
  return parsePatchRunResult({
    specId: tenant.specId,
    specRevision: 1,
    baseSha: tenant.baseSha,
    patchSha256: await createPatchHash(tenant.baseSha, files),
    files,
    findings: [
      {
        id: "f1.stripe.constructor.new",
        ruleId: "stripe.constructor.new",
        filePath: path,
        fileSha256: sha256(ORIGINAL),
        classification: "affected",
        confidence: 1,
        rationale: "Construct the v22 client with new.",
        citationArtifactIds: ["stripe-node-v22-guide"],
      },
    ],
    edits: [
      {
        id: "e1.stripe.constructor.new",
        ruleId: "stripe.constructor.new",
        filePath: path,
        beforeSha256: sha256(ORIGINAL),
        afterSha256: sha256(newContent),
        transformation: "deterministic_codemod",
        rationale: "Instantiate the v22 ES class export with new.",
        citationArtifactIds: ["stripe-node-v22-guide"],
      },
    ],
    unresolvedFindingIds: [],
    integrity: {
      allowedPathsPassed: true,
      fileHashesPassed: true,
      noBinaryChangesPassed: true,
      noWorkflowChangesPassed: true,
      patchSizePassed: true,
      syntaxPassed: true,
      baseShaPassed: true,
      ...overrides?.integrity,
    },
    workerIssues: [],
    validation: [
      {
        category: "test",
        command: "npm run test",
        outcome,
        ...(outcome === "incomplete" ? {} : { exitCode: outcome === "passed" ? 0 : 1 }),
        durationMs: 1_200,
        summary: `test ${outcome}`,
      },
    ],
    validationLogs: [
      {
        category: "test",
        command: "npm run test",
        output: "1 passing\n",
        truncated: false,
      },
    ],
    versions: {
      detector: "stripe-v20-v22-analyzer/1.0.0",
      transformer: "stripe-v20-v22-transformer/1.0.0",
      sandboxImage: "autopilot-node-24",
    },
    executionPolicy: {
      network: "none",
      allowedHosts: [],
      cpuCount: 2,
      memoryMiB: 2_048,
      diskMiB: 8_192,
      maxProcesses: 256,
      maxOutputBytes: 2_097_152,
      timeoutSeconds: 1_200,
    },
    cost: {
      modelInputTokens: 0,
      modelOutputTokens: 0,
      modelCostUsd: 0,
      sandboxSeconds: 42,
    },
    cleanup: {
      sourceDeletedAt: new Date().toISOString(),
      sandboxDestroyedAt: new Date().toISOString(),
      complete: true,
    },
  });
}

async function expectDomainError(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal(
      (error as { code?: string }).code,
      code,
      `expected ${code} but received ${(error as { code?: string }).code}: ${
        (error as Error).message
      }`,
    );
    return true;
  });
}

test.beforeEach(() => {
  resetControlPlane();
});

test("model consent requires an approver and the currently published disclosure", async () => {
  const tenant = await seedTenant();

  await expectDomainError(
    grantModelConsent({
      tenant: tenant.tenantFor("viewer"),
      repositoryMigrationId: tenant.repositoryMigrationId,
      acknowledgedPolicyVersion: MODEL_CONSENT_POLICY_VERSION,
    }),
    "FORBIDDEN",
  );
  await expectDomainError(
    grantModelConsent({
      tenant: tenant.tenantFor("operator"),
      repositoryMigrationId: tenant.repositoryMigrationId,
      acknowledgedPolicyVersion: MODEL_CONSENT_POLICY_VERSION,
    }),
    "FORBIDDEN",
  );
  await expectDomainError(
    grantModelConsent({
      tenant: tenant.tenantFor("approver"),
      repositoryMigrationId: tenant.repositoryMigrationId,
      acknowledgedPolicyVersion: "external-model-processing/1999-01-01",
    }),
    "VALIDATION_FAILED",
  );

  const grant = await grantModelConsent({
    tenant: tenant.tenantFor("approver"),
    repositoryMigrationId: tenant.repositoryMigrationId,
    acknowledgedPolicyVersion: MODEL_CONSENT_POLICY_VERSION,
  });
  assert.equal(grant.policyVersion, MODEL_CONSENT_POLICY_VERSION);
  await assertModelProcessingAllowed({
    organizationId: tenant.customerOrganizationId,
    repositoryMigrationId: tenant.repositoryMigrationId,
  });

  await revokeModelConsent({
    tenant: tenant.tenantFor("approver"),
    repositoryMigrationId: tenant.repositoryMigrationId,
  });
  await expectDomainError(
    assertModelProcessingAllowed({
      organizationId: tenant.customerOrganizationId,
      repositoryMigrationId: tenant.repositoryMigrationId,
    }),
    "FORBIDDEN",
  );
});

test("consent cannot be granted across tenants", async () => {
  const first = await seedTenant();
  const second = await seedTenant();

  await expectDomainError(
    grantModelConsent({
      tenant: first.tenantFor("approver"),
      repositoryMigrationId: second.repositoryMigrationId,
      acknowledgedPolicyVersion: MODEL_CONSENT_POLICY_VERSION,
    }),
    "NOT_FOUND",
  );
});

test("patch requests are refused before any GitHub call when preconditions fail", async () => {
  const viewerTenant = await seedTenant();
  await expectDomainError(
    requestPatch({
      tenant: viewerTenant.tenantFor("viewer"),
      repositoryMigrationId: viewerTenant.repositoryMigrationId,
      validationCategories: ["test"],
      requestUrl: "https://autopilot.test/api/patches",
    }),
    "FORBIDDEN",
  );

  const noPatcher = await seedTenant({ patcherActive: false });
  await expectDomainError(
    requestPatch({
      tenant: noPatcher.tenantFor("approver"),
      repositoryMigrationId: noPatcher.repositoryMigrationId,
      validationCategories: ["test"],
      requestUrl: "https://autopilot.test/api/patches",
    }),
    "INVALID_STATE_TRANSITION",
  );

  const notAutoPatchable = await seedTenant({ autoPatchEligible: false });
  await expectDomainError(
    requestPatch({
      tenant: notAutoPatchable.tenantFor("approver"),
      repositoryMigrationId: notAutoPatchable.repositoryMigrationId,
      validationCategories: ["test"],
      requestUrl: "https://autopilot.test/api/patches",
    }),
    "VALIDATION_FAILED",
  );

  const wrongState = await seedTenant({ migrationState: "draft_pr_open" });
  await expectDomainError(
    requestPatch({
      tenant: wrongState.tenantFor("approver"),
      repositoryMigrationId: wrongState.repositoryMigrationId,
      validationCategories: ["test"],
      requestUrl: "https://autopilot.test/api/patches",
    }),
    "INVALID_STATE_TRANSITION",
  );

  const crossTenant = await seedTenant();
  await expectDomainError(
    requestPatch({
      tenant: crossTenant.tenantFor("approver"),
      repositoryMigrationId: viewerTenant.repositoryMigrationId,
      validationCategories: ["test"],
      requestUrl: "https://autopilot.test/api/patches",
    }),
    "NOT_FOUND",
  );
});

test("a submitted patch persists an encrypted artifact, a parsed manifest, and a recomputable hash", async () => {
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant);
  const result = await buildPatchResult(tenant);

  const submitted = await submitPatchResult({ runId, result });
  assert.equal(submitted.state, "awaiting_review");
  assert.equal(submitted.integrityValid, true);

  const persisted = await readPersistedPatch(
    tenant.customerOrganizationId,
    runId,
  );
  assert.equal(persisted.recomputedSha256, result.patchSha256);
  assert.equal(persisted.files[0]?.newContent, PATCHED);

  // The stored object must be ciphertext, never readable source.
  const stored = [...testBucket.objects.entries()].find(([key]) =>
    key.endsWith(`runs/${runId}/patch.json`),
  );
  assert.ok(stored, "the patch artifact should be written to object storage");
  const raw = new TextDecoder().decode(stored[1].body);
  assert.doesNotMatch(raw, /process\.env\.KEY/);

  const run = await getD1()
    .prepare("SELECT state, manifest FROM migration_runs WHERE id = ?")
    .bind(runId)
    .first<{ state: string; manifest: string }>();
  assert.equal(run?.state, "awaiting_review");
  const manifest = JSON.parse(run?.manifest ?? "{}") as {
    patch: { sha256: string };
    audit: { rootHash: string };
    allowedPaths: string[];
  };
  assert.equal(manifest.patch.sha256, result.patchSha256);
  assert.match(manifest.audit.rootHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.allowedPaths, ["src/billing.ts"]);
});

test("a patch touching an unauthorized path is never persisted as reviewable work", async () => {
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant);
  const result = await buildPatchResult(tenant, { path: "src/unrelated.ts" });

  const submitted = await submitPatchResult({ runId, result });
  assert.equal(submitted.integrityValid, false);
  assert.equal(submitted.state, "failed");

  const run = await getD1()
    .prepare(
      "SELECT state, failure_code AS failureCode FROM migration_runs WHERE id = ?",
    )
    .bind(runId)
    .first<{ state: string; failureCode: string }>();
  assert.equal(run?.state, "failed");
  assert.equal(run?.failureCode, "patch_boundary_rejected");

  const patchCount = await getD1()
    .prepare("SELECT COUNT(*) AS count FROM patches WHERE run_id = ?")
    .bind(runId)
    .first<{ count: number }>();
  assert.equal(Number(patchCount?.count), 0);

  // With no persisted patch there is nothing an approver can bind a hash to.
  await expectDomainError(
    approvePatch({
      tenant: tenant.tenantFor("approver"),
      runId,
      patchHash: result.patchSha256,
      intent: "open-draft-pr",
    }),
    "INVALID_STATE_TRANSITION",
  );
  assert.equal(
    await customerPatchReview(
      tenant.customerOrganizationId,
      tenant.repositoryMigrationId,
    ),
    null,
  );
});

test("a workflow-file edit can never become an approvable patch", async () => {
  // Even when the assessment authorized the path, the boundary refuses it.
  const tenant = await seedTenant({
    affectedPaths: [".github/workflows/ci.yml"],
  });
  const runId = await seedPatchRun(tenant);
  const result = await buildPatchResult(tenant, {
    path: ".github/workflows/ci.yml",
  });

  const submitted = await submitPatchResult({ runId, result });
  assert.equal(submitted.integrityValid, false);
  assert.equal(submitted.state, "failed");

  const rejection = await getD1()
    .prepare(
      "SELECT payload FROM audit_events WHERE aggregate_id = ? AND action = 'patch.rejected' LIMIT 1",
    )
    .bind(runId)
    .first<{ payload: string }>();
  assert.match(rejection?.payload ?? "", /workflow-file/);
});

test("approval binds the exact stored hash and refuses stale or forged hashes", async () => {
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant);
  const result = await buildPatchResult(tenant);
  await submitPatchResult({ runId, result });

  await expectDomainError(
    approvePatch({
      tenant: tenant.tenantFor("operator"),
      runId,
      patchHash: result.patchSha256,
      intent: "open-draft-pr",
    }),
    "FORBIDDEN",
  );
  await expectDomainError(
    approvePatch({
      tenant: tenant.tenantFor("approver"),
      runId,
      patchHash: "f".repeat(64),
      intent: "open-draft-pr",
    }),
    "CONCURRENT_MODIFICATION",
  );
  await expectDomainError(
    approvePatch({
      tenant: tenant.tenantFor("approver"),
      runId,
      patchHash: "not-a-hash",
      intent: "open-draft-pr",
    }),
    "VALIDATION_FAILED",
  );

  const approval = await approvePatch({
    tenant: tenant.tenantFor("approver"),
    runId,
    patchHash: result.patchSha256,
    intent: "open-draft-pr",
  });
  assert.equal(approval.approvedPatchSha256, result.patchSha256);
  assert.equal(approval.warned, false);

  const run = await getD1()
    .prepare(
      "SELECT state, approved_patch_sha256 AS approved, approved_by_membership_id AS actor FROM migration_runs WHERE id = ?",
    )
    .bind(runId)
    .first<{ state: string; approved: string; actor: string }>();
  assert.equal(run?.state, "approved");
  assert.equal(run?.approved, result.patchSha256);
  assert.equal(run?.actor, tenant.memberships.approver);
});

test("approval after failed validation is allowed but recorded as warned", async () => {
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant);
  const result = await buildPatchResult(tenant, {
    validationOutcome: "failed",
  });
  const submitted = await submitPatchResult({ runId, result });
  assert.equal(submitted.state, "validation_failed");

  const approval = await approvePatch({
    tenant: tenant.tenantFor("approver"),
    runId,
    patchHash: result.patchSha256,
    intent: "open-draft-pr",
  });
  assert.equal(approval.warned, true);
});

test("publication refuses without approval, with an inactive Patcher App, or after tampering", async () => {
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant);
  const result = await buildPatchResult(tenant);
  await submitPatchResult({ runId, result });

  await expectDomainError(
    publishApprovedPatch({ tenant: tenant.tenantFor("approver"), runId }),
    "INVALID_STATE_TRANSITION",
  );

  await approvePatch({
    tenant: tenant.tenantFor("approver"),
    runId,
    patchHash: result.patchSha256,
    intent: "open-draft-pr",
  });

  await expectDomainError(
    publishApprovedPatch({ tenant: tenant.tenantFor("viewer"), runId }),
    "FORBIDDEN",
  );

  await getD1()
    .prepare("UPDATE github_installations SET status = 'revoked' WHERE app_kind = 'patcher'")
    .run();
  await expectDomainError(
    publishApprovedPatch({ tenant: tenant.tenantFor("approver"), runId }),
    "FORBIDDEN",
  );
  await getD1()
    .prepare("UPDATE github_installations SET status = 'active' WHERE app_kind = 'patcher'")
    .run();

  // Rewrite the stored ciphertext with a different but internally consistent
  // patch: the recorded hash no longer matches, so publication stops.
  const forged = await buildPatchResult(tenant, {
    newContent: "const stripe = new Stripe(process.env.OTHER);\n",
  });
  const { storeRunArtifact: store } = await import("@/lib/data/artifacts");
  await store({
    organizationId: tenant.customerOrganizationId,
    runId,
    kind: "patch",
    storageKey: `runs/${runId}/patch.json`,
    contentType: "application/json",
    plaintext: JSON.stringify({
      baseSha: tenant.baseSha,
      patchSha256: forged.patchSha256,
      files: forged.files,
    }),
  });
  await expectDomainError(
    publishApprovedPatch({ tenant: tenant.tenantFor("approver"), runId }),
    "VALIDATION_FAILED",
  );
});

test("provider queries never expose repository-derived detail", async () => {
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant);
  await submitPatchResult({ runId, result: await buildPatchResult(tenant) });

  const dashboard = await providerDashboard(tenant.providerOrganizationId);
  const serialized = JSON.stringify(dashboard);
  assert.doesNotMatch(serialized, /billing-service|src\/billing\.ts|customer-org/);
  assert.deepEqual(Object.keys(dashboard).sort(), [
    "affectedCustomers",
    "campaignCount",
    "connectedCustomers",
    "invitations",
    "liveCampaigns",
    "openPullRequests",
  ]);
  for (const value of Object.values(dashboard)) {
    assert.equal(typeof value, "number");
  }

  // The provider organization has no workspace rows of its own.
  const providerWorkspace = await customerWorkspaceData(
    tenant.providerOrganizationId,
  );
  assert.equal(providerWorkspace.migrations.length, 0);
  assert.equal(providerWorkspace.repositories.length, 0);
  assert.equal(providerWorkspace.selectedFindings.length, 0);

  // And it cannot read the customer's patch review surface.
  assert.equal(
    await customerPatchReview(
      tenant.providerOrganizationId,
      tenant.repositoryMigrationId,
    ),
    null,
  );
});

test("run status reports persisted stages without repository detail", async () => {
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant);
  await recordRunStage({
    organizationId: tenant.customerOrganizationId,
    runId,
    stage: "deterministic_codemod",
    status: "completed",
    detail: { editCount: 1 },
  });
  await submitPatchResult({ runId, result: await buildPatchResult(tenant) });

  const status = await runStatus(tenant.customerOrganizationId, runId);
  assert.equal(status?.state, "awaiting_review");
  const stages = await listRunStages(tenant.customerOrganizationId, runId);
  assert.deepEqual(
    stages.map((stage) => stage.stage),
    ["deterministic_codemod", "manifest_persistence", "sandbox_cleanup"],
  );
  assert.doesNotMatch(JSON.stringify(status), /src\/billing\.ts|process\.env/);

  // Another tenant cannot read the same run.
  const other = await seedTenant();
  assert.equal(await runStatus(other.customerOrganizationId, runId), null);
});

test("expired artifacts are deleted with storage verification and fail closed afterwards", async () => {
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant);
  await submitPatchResult({ runId, result: await buildPatchResult(tenant) });

  const artifact = await getD1()
    .prepare(
      "SELECT id, storage_key AS storageKey FROM artifacts WHERE run_id = ? AND kind = 'patch' LIMIT 1",
    )
    .bind(runId)
    .first<{ id: string; storageKey: string }>();
  assert.ok(artifact);
  assert.ok(
    await readRunArtifact({
      organizationId: tenant.customerOrganizationId,
      artifactId: artifact.id,
    }),
  );

  await getD1()
    .prepare("UPDATE artifacts SET expires_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - 1_000).toISOString(), artifact.id)
    .run();

  const report = await sweepRetention();
  assert.ok(report.expiredArtifacts >= 1);
  assert.ok(report.deleted >= 1);
  assert.equal(report.deadLettered, 0);

  const row = await getD1()
    .prepare(
      "SELECT lifecycle_state AS state, deletion_verified_at AS verifiedAt FROM artifacts WHERE id = ?",
    )
    .bind(artifact.id)
    .first<{ state: string; verifiedAt: string | null }>();
  assert.equal(row?.state, "deleted");
  assert.ok(row?.verifiedAt);
  assert.equal(
    [...testBucket.objects.keys()].some((key) =>
      key.endsWith(artifact.storageKey),
    ),
    false,
  );

  await expectDomainError(
    readRunArtifact({
      organizationId: tenant.customerOrganizationId,
      artifactId: artifact.id,
    }),
    "NOT_FOUND",
  );
});

test("interrupted runs are swept within the 24-hour hard deadline", async () => {
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant, { state: "generating" });
  await storeRunArtifact({
    organizationId: tenant.customerOrganizationId,
    runId,
    kind: "affected_snippets",
    storageKey: `runs/${runId}/snippets.json`,
    contentType: "application/json",
    plaintext: JSON.stringify({ snippet: "const stripe = Stripe(key);" }),
  });

  const stale = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString();
  await getD1()
    .prepare("UPDATE migration_runs SET updated_at = ? WHERE id = ?")
    .bind(stale, runId)
    .run();

  const report = await sweepRetention();
  assert.equal(report.interruptedRuns, 1);
  assert.ok(report.deleted >= 1);

  const run = await getD1()
    .prepare(
      "SELECT state, failure_code AS failureCode FROM migration_runs WHERE id = ?",
    )
    .bind(runId)
    .first<{ state: string; failureCode: string }>();
  assert.equal(run?.state, "failed");
  assert.equal(run?.failureCode, "interrupted_run_ttl");
  assert.equal(testBucket.objects.size, 0);
});

test("a deletion that object storage does not honour retries and dead-letters", async () => {
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant);
  const artifact = await storeRunArtifact({
    organizationId: tenant.customerOrganizationId,
    runId,
    kind: "validation_log",
    storageKey: `runs/${runId}/logs/test.log`,
    contentType: "text/plain",
    plaintext: "1 passing",
  });
  await getD1()
    .prepare("UPDATE artifacts SET expires_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - 1_000).toISOString(), artifact.id)
    .run();

  const originalDelete = testBucket.delete.bind(testBucket);
  testBucket.delete = () => Promise.resolve();
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sweepRetention({
        now: new Date(Date.now() + attempt * 12 * 60 * 60 * 1_000),
      });
    }
  } finally {
    testBucket.delete = originalDelete;
  }

  const job = await getD1()
    .prepare(
      "SELECT status, attempt_count AS attempts FROM deletion_jobs WHERE artifact_id = ?",
    )
    .bind(artifact.id)
    .first<{ status: string; attempts: number }>();
  assert.equal(job?.status, "failed");
  assert.equal(job?.attempts, 8);

  const row = await getD1()
    .prepare("SELECT lifecycle_state AS state FROM artifacts WHERE id = ?")
    .bind(artifact.id)
    .first<{ state: string }>();
  assert.equal(row?.state, "deletion_failed");
});

test("a patch result cannot skip the repository migration state machine", async () => {
  const tenant = await seedTenant();
  // The migration is still awaiting review of a previous patch, so a fresh
  // result must not silently overwrite it.
  const runId = await seedPatchRun(tenant, { migrationState: "draft_pr_open" });

  await expectDomainError(
    submitPatchResult({ runId, result: await buildPatchResult(tenant) }),
    "INVALID_STATE_TRANSITION",
  );
});

test("the work packet advances the migration to generating exactly once", async () => {
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant, {
    state: "queued",
    migrationState: "patch_requested",
  });

  const packet = await patchWorkPacket(runId);
  assert.equal(packet?.runId, runId);
  assert.deepEqual(packet?.allowedPaths, ["src/billing.ts"]);
  assert.equal(packet?.modelProcessingAllowed, false);

  const after = await getD1()
    .prepare(
      `SELECT mr.state AS runState, rm.state AS migrationState
       FROM migration_runs mr
       JOIN repository_migrations rm ON rm.id = mr.repository_migration_id
       WHERE mr.id = ?`,
    )
    .bind(runId)
    .first<{ runState: string; migrationState: string }>();
  assert.equal(after?.runState, "acquiring_source");
  assert.equal(after?.migrationState, "generating");

  // Re-issuing the packet is safe and does not move the migration again.
  const second = await patchWorkPacket(runId);
  assert.equal(second?.runId, runId);
  const stable = await getD1()
    .prepare("SELECT state FROM repository_migrations WHERE id = ?")
    .bind(tenant.repositoryMigrationId)
    .first<{ state: string }>();
  assert.equal(stable?.state, "generating");
});

test("model consent revoked mid-run closes the snippet gate before the next request", async () => {
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant, {
    state: "queued",
    migrationState: "patch_requested",
  });
  await grantModelConsent({
    tenant: tenant.tenantFor("approver"),
    repositoryMigrationId: tenant.repositoryMigrationId,
    acknowledgedPolicyVersion: MODEL_CONSENT_POLICY_VERSION,
  });

  const packet = await patchWorkPacket(runId);
  assert.equal(packet?.modelProcessingAllowed, true);
  assert.equal(
    (await checkModelConsentForRun(runId)).allowed,
    true,
    "the gate should be open while the grant is live",
  );

  await revokeModelConsent({
    tenant: tenant.tenantFor("approver"),
    repositoryMigrationId: tenant.repositoryMigrationId,
  });
  const gate = await checkModelConsentForRun(runId);
  assert.equal(gate.allowed, false);
  assert.equal(gate.policyVersion, null);
});
