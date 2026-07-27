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
const {
  approvePatch,
  listPatchReviewFiles,
  publishApprovedPatch,
  readPersistedPatch,
  readPersistedPatchFile,
} = await import("@/lib/data/publication");
const { customerPatchReview, customerWorkspaceData, runStatus } = await import(
  "@/lib/data/customer"
);
const { providerDashboard } = await import("@/lib/data/control-plane");
const { completeAssessment } = await import("@/lib/data/assessments");
const { processWorkflowResult } = await import("@/lib/data/workflow-results");
const { readRunArtifact, storeRunArtifact } = await import(
  "@/lib/data/artifacts"
);
const { sweepRetention } = await import("@/lib/data/retention");
const { MODEL_CONSENT_POLICY_VERSION } = await import("@/lib/domain");
const { createPatchHash } = await import("@/lib/migration/patch-security");
const { GitHubIntegrationError } = await import("@/lib/integrations/github");
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

async function buildTwoFilePatchResult(tenant: SeededTenant) {
  const originalOther = "export const amount = Stripe.Decimal;\n";
  const patchedOther = "export const amount = Decimal;\n";
  const files = [
    {
      path: "src/billing.ts",
      originalContent: ORIGINAL,
      newContent: PATCHED,
      ruleIds: ["stripe.constructor.new"],
      rationale: ["Instantiate the v22 ES class export with new."],
    },
    {
      path: "src/other.ts",
      originalContent: originalOther,
      newContent: patchedOther,
      ruleIds: ["stripe.decimal.import"],
      rationale: ["Use the supported Decimal export."],
    },
  ];
  const base = await buildPatchResult(tenant);
  return parsePatchRunResult({
    ...base,
    patchSha256: await createPatchHash(tenant.baseSha, files),
    files,
    findings: [
      ...base.findings,
      {
        id: "f2.stripe.decimal.import",
        ruleId: "stripe.decimal.import",
        filePath: "src/other.ts",
        fileSha256: sha256(originalOther),
        classification: "affected",
        confidence: 1,
        rationale: "Use the supported Decimal export.",
        citationArtifactIds: ["stripe-node-v22-guide"],
      },
    ],
    edits: [
      ...base.edits,
      {
        id: "e2.stripe.decimal.import",
        ruleId: "stripe.decimal.import",
        filePath: "src/other.ts",
        beforeSha256: sha256(originalOther),
        afterSha256: sha256(patchedOther),
        transformation: "deterministic_codemod",
        rationale: "Use the supported Decimal export.",
        citationArtifactIds: ["stripe-node-v22-guide"],
      },
    ],
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

test("workflow result receipts serialize concurrent delivery and replay the exact response", async () => {
  const tenant = await seedTenant();
  let release: (() => void) | undefined;
  let claimed: (() => void) | undefined;
  const claimedPromise = new Promise<void>((resolve) => {
    claimed = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  let processCalls = 0;
  const input = {
    runId: tenant.assessmentRunId,
    organizationId: tenant.customerOrganizationId,
    kind: "assessment" as const,
    payload: { result: "exact" },
  };
  const first = processWorkflowResult({
    ...input,
    process: async () => {
      processCalls += 1;
      claimed?.();
      await releasePromise;
      return { completed: true };
    },
  });
  await claimedPromise;
  await expectDomainError(
    processWorkflowResult({
      ...input,
      process: async () => ({ completed: false }),
    }),
    "CONCURRENT_MODIFICATION",
  );
  release?.();
  assert.deepEqual(await first, { completed: true });
  assert.deepEqual(
    await processWorkflowResult({
      ...input,
      process: async () => {
        processCalls += 1;
        return { completed: false };
      },
    }),
    { completed: true },
  );
  assert.equal(processCalls, 1);
});

test("assessment completion accepts the run-bound spec and persists encrypted execution evidence", async () => {
  const tenant = await seedTenant();
  const database = getD1();
  await database.batch([
    database
      .prepare(
        `DELETE FROM findings
         WHERE organization_id = ? AND run_id = ?`,
      )
      .bind(tenant.customerOrganizationId, tenant.assessmentRunId),
    database
      .prepare(
        `UPDATE migration_runs
         SET state = 'analyzing', manifest = null, completed_at = null
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(tenant.assessmentRunId, tenant.customerOrganizationId),
    database
      .prepare(
        `UPDATE repository_migrations
         SET state = 'assessing', assessment_summary = null
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(tenant.repositoryMigrationId, tenant.customerOrganizationId),
  ]);
  const destroyedAt = new Date().toISOString();
  const assessmentResult = {
    runId: tenant.assessmentRunId,
    assessment: {
      specId: tenant.specId,
      specRevision: 1,
      status: "no-impact",
      dependency: {
        packageName: "stripe",
        declaredRange: "^20.3.0",
        resolvedVersion: "20.3.0",
        manifestPath: "package.json",
        lockfilePath: "package-lock.json",
        supportedSource: true,
        targetSatisfied: false,
        warnings: [],
      },
      findings: [],
      scannedFiles: ["src/billing.ts"],
      skipped: [],
    },
    skipped: [],
    execution: {
      analyzerVersion: "spec-driven-analyzer/2.0.0",
      sandboxId: "sandbox_test",
      sandboxImageVersion: "node-24-assessment/1",
      network: "none",
      sandboxDestroyedAt: destroyedAt,
      sourceDeletedAt: destroyedAt,
    },
  } satisfies Parameters<typeof completeAssessment>[0];
  await completeAssessment(assessmentResult);
  const run = await database
    .prepare(
      `SELECT state, manifest
       FROM migration_runs
       WHERE id = ? AND organization_id = ?`,
    )
    .bind(tenant.assessmentRunId, tenant.customerOrganizationId)
    .first<{ state: string; manifest: string }>();
  assert.equal(run?.state, "cleaned");
  const manifest = JSON.parse(run?.manifest ?? "{}") as {
    schemaVersion?: string;
    migrationSpecId?: string;
    executionPolicy?: { network?: string; repositoryCodeExecuted?: boolean };
    artifact?: { id?: string; sha256?: string };
  };
  assert.equal(manifest.schemaVersion, "2");
  assert.equal(manifest.migrationSpecId, tenant.specId);
  assert.equal(manifest.executionPolicy?.network, "none");
  assert.equal(manifest.executionPolicy?.repositoryCodeExecuted, false);
  assert.match(manifest.artifact?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok(
    [...testBucket.objects.keys()].some((key) =>
      key.endsWith("/assessment-manifest-v2.json.enc"),
    ),
  );
  const workspace = await customerWorkspaceData(
    tenant.customerOrganizationId,
    tenant.repositoryMigrationId,
  );
  assert.deepEqual(
    workspace.selectedMigration?.assessmentSummary?.scannedPaths,
    ["src/billing.ts"],
  );

  const beforeReplay = await database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM artifacts WHERE run_id = ?) AS artifacts,
        (SELECT COUNT(*) FROM audit_events
          WHERE aggregate_id = ? AND action = 'assessment.completed') AS audits`,
    )
    .bind(tenant.assessmentRunId, tenant.assessmentRunId)
    .first<{ artifacts: number; audits: number }>();
  await completeAssessment(assessmentResult);
  const afterReplay = await database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM artifacts WHERE run_id = ?) AS artifacts,
        (SELECT COUNT(*) FROM audit_events
          WHERE aggregate_id = ? AND action = 'assessment.completed') AS audits`,
    )
    .bind(tenant.assessmentRunId, tenant.assessmentRunId)
    .first<{ artifacts: number; audits: number }>();
  assert.deepEqual(afterReplay, beforeReplay);

  await expectDomainError(
    completeAssessment({
      ...assessmentResult,
      assessment: {
        ...assessmentResult.assessment,
        scannedFiles: ["src/billing.ts", "src/other.ts"],
      },
    }),
    "CONCURRENT_MODIFICATION",
  );
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

  const beforeReplay = await getD1()
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM patches WHERE run_id = ?) AS patches,
        (SELECT COUNT(*) FROM patch_review_files WHERE run_id = ?) AS files,
        (SELECT COUNT(*) FROM artifacts WHERE run_id = ?) AS artifacts,
        (SELECT COUNT(*) FROM audit_events
          WHERE aggregate_id = ? AND action = 'patch.generated') AS audits`,
    )
    .bind(runId, runId, runId, runId)
    .first<{
      patches: number;
      files: number;
      artifacts: number;
      audits: number;
    }>();
  assert.deepEqual(await submitPatchResult({ runId, result }), submitted);
  const afterReplay = await getD1()
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM patches WHERE run_id = ?) AS patches,
        (SELECT COUNT(*) FROM patch_review_files WHERE run_id = ?) AS files,
        (SELECT COUNT(*) FROM artifacts WHERE run_id = ?) AS artifacts,
        (SELECT COUNT(*) FROM audit_events
          WHERE aggregate_id = ? AND action = 'patch.generated') AS audits`,
    )
    .bind(runId, runId, runId, runId)
    .first<{
      patches: number;
      files: number;
      artifacts: number;
      audits: number;
    }>();
  assert.deepEqual(afterReplay, beforeReplay);
  await expectDomainError(
    submitPatchResult({
      runId,
      result: {
        ...result,
        unresolvedFindingIds: ["f1.stripe.constructor.new"],
      },
    }),
    "CONCURRENT_MODIFICATION",
  );
});

test("patch review lists metadata without decrypting the aggregate and reads only the selected tenant file", async () => {
  const tenant = await seedTenant({
    affectedPaths: ["src/billing.ts", "src/other.ts"],
  });
  const runId = await seedPatchRun(tenant);
  await submitPatchResult({
    runId,
    result: await buildTwoFilePatchResult(tenant),
  });

  const metadata = await listPatchReviewFiles(
    tenant.customerOrganizationId,
    runId,
  );
  assert.deepEqual(
    metadata.map((file) => file.path),
    ["src/billing.ts", "src/other.ts"],
  );
  assert.doesNotMatch(JSON.stringify(metadata), /process\.env|Stripe\.Decimal/);

  const aggregate = await getD1()
    .prepare(
      "SELECT storage_key AS storageKey FROM artifacts WHERE run_id = ? AND kind = 'patch' LIMIT 1",
    )
    .bind(runId)
    .first<{ storageKey: string }>();
  assert.ok(aggregate);
  testBucket.objects.delete(aggregate.storageKey);

  const review = await customerPatchReview(
    tenant.customerOrganizationId,
    tenant.repositoryMigrationId,
  );
  assert.equal(review?.files.length, 2);
  assert.doesNotMatch(JSON.stringify(review), /process\.env|Stripe\.Decimal/);

  const selected = await readPersistedPatchFile({
    organizationId: tenant.customerOrganizationId,
    runId,
    path: "src/other.ts",
  });
  assert.equal(selected.newContent, "export const amount = Decimal;\n");
  assert.doesNotMatch(selected.originalContent, /process\.env/);

  const other = await seedTenant();
  await expectDomainError(
    readPersistedPatchFile({
      organizationId: other.customerOrganizationId,
      runId,
      path: "src/other.ts",
    }),
    "NOT_FOUND",
  );
  await expectDomainError(
    readPersistedPatchFile({
      organizationId: tenant.customerOrganizationId,
      runId,
      path: "src/missing.ts",
    }),
    "NOT_FOUND",
  );
});

test("an expired selected-file artifact disappears from metadata and fails closed", async () => {
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant);
  await submitPatchResult({ runId, result: await buildPatchResult(tenant) });

  const artifact = await getD1()
    .prepare(
      "SELECT a.id FROM artifacts a JOIN patch_review_files prf ON prf.artifact_id = a.id WHERE prf.run_id = ? LIMIT 1",
    )
    .bind(runId)
    .first<{ id: string }>();
  assert.ok(artifact);
  await getD1()
    .prepare("UPDATE artifacts SET expires_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - 1_000).toISOString(), artifact.id)
    .run();

  assert.deepEqual(
    await listPatchReviewFiles(tenant.customerOrganizationId, runId),
    [],
  );
  await expectDomainError(
    readPersistedPatchFile({
      organizationId: tenant.customerOrganizationId,
      runId,
      path: "src/billing.ts",
    }),
    "NOT_FOUND",
  );
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

  const manifest = await getD1()
    .prepare("SELECT manifest FROM migration_runs WHERE id = ?")
    .bind(runId)
    .first<{ manifest: string }>();
  const parsedManifest = JSON.parse(manifest?.manifest ?? "{}") as {
    approval?: {
      patchSha256: string;
      approvedByMembershipId: string;
      approvedAt: string;
    };
  };
  assert.equal(
    parsedManifest.approval?.approvedByMembershipId,
    tenant.memberships.approver,
  );
  assert.equal(
    parsedManifest.approval?.patchSha256,
    result.patchSha256,
  );
  const manifestArtifact = await getD1()
    .prepare(
      "SELECT id FROM artifacts WHERE run_id = ? AND kind = 'run_manifest' AND lifecycle_state = 'active'",
    )
    .bind(runId)
    .first<{ id: string }>();
  assert.ok(manifestArtifact);
  assert.match(
    await readRunArtifact({
      organizationId: tenant.customerOrganizationId,
      artifactId: manifestArtifact.id,
    }),
    /approvedByMembershipId/,
  );
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

test("successful publication finalizes the actual approver and draft PR identity", async () => {
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant);
  const result = await buildPatchResult(tenant);
  await submitPatchResult({ runId, result });
  await approvePatch({
    tenant: tenant.tenantFor("approver"),
    runId,
    patchHash: result.patchSha256,
    intent: "open-draft-pr",
  });

  let publishedBody = "";
  const publication = await publishApprovedPatch({
    tenant: tenant.tenantFor("admin"),
    runId,
    gateway: {
      getBranchSha: async () => tenant.baseSha,
      publishDraftPullRequest: async (input) => {
        publishedBody = input.body;
        return {
          number: 42,
          url: "https://github.test/customer/repository/pull/42",
          branch: `migration-autopilot/campaign/${runId}`,
          headSha: "b".repeat(40),
          existing: false,
        };
      },
    },
  });
  assert.equal(publication.number, 42);
  assert.match(publishedBody, new RegExp(result.patchSha256));
  assert.match(publishedBody, /draft/i);

  const persisted = await getD1()
    .prepare(
      "SELECT state, manifest FROM migration_runs WHERE id = ? AND organization_id = ?",
    )
    .bind(runId, tenant.customerOrganizationId)
    .first<{ state: string; manifest: string }>();
  assert.equal(persisted?.state, "pr_open");
  const manifest = JSON.parse(persisted?.manifest ?? "{}") as {
    approval?: { approvedByMembershipId: string };
    pullRequest?: {
      number: number;
      url: string;
      branch: string;
      draft: boolean;
    };
  };
  assert.equal(
    manifest.approval?.approvedByMembershipId,
    tenant.memberships.approver,
    "publication must preserve the actor who approved, not the later publisher",
  );
  assert.deepEqual(manifest.pullRequest, {
    provider: "github",
    number: 42,
    url: "https://github.test/customer/repository/pull/42",
    branch: `migration-autopilot/campaign/${runId}`,
    draft: true,
  });

  const retry = await publishApprovedPatch({
    tenant: tenant.tenantFor("approver"),
    runId,
    gateway: {
      getBranchSha: async () => {
        throw new Error("An idempotent retry must not call GitHub.");
      },
      publishDraftPullRequest: async () => {
        throw new Error("An idempotent retry must not write to GitHub.");
      },
    },
  });
  assert.equal(retry.existing, true);
  assert.equal(retry.number, 42);
});

test("publication records stale-base refusal and a redacted operational alert before any write", async () => {
  const tenant = await seedTenant();
  const runId = await seedPatchRun(tenant);
  const result = await buildPatchResult(tenant);
  await submitPatchResult({ runId, result });
  await approvePatch({
    tenant: tenant.tenantFor("approver"),
    runId,
    patchHash: result.patchSha256,
    intent: "open-draft-pr",
  });

  let writes = 0;
  await expectDomainError(
    publishApprovedPatch({
      tenant: tenant.tenantFor("approver"),
      runId,
      gateway: {
        getBranchSha: async () => "c".repeat(40),
        publishDraftPullRequest: async () => {
          writes += 1;
          throw new Error("must not write");
        },
      },
    }),
    "CONCURRENT_MODIFICATION",
  );
  assert.equal(writes, 0);
  const persisted = await getD1()
    .prepare(
      "SELECT state, failure_category AS failureCategory, failure_code AS failureCode FROM migration_runs WHERE id = ?",
    )
    .bind(runId)
    .first<{
      state: string;
      failureCategory: string;
      failureCode: string;
    }>();
  assert.equal(persisted?.state, "approved");
  assert.equal(persisted?.failureCategory, "stale_base");
  assert.equal(persisted?.failureCode, "default_branch_moved");
  const alert = await getD1()
    .prepare(
      "SELECT code FROM operational_alerts WHERE organization_id = ? AND run_id = ?",
    )
    .bind(tenant.customerOrganizationId, runId)
    .first<{ code: string }>();
  assert.equal(alert?.code, "github.draft_pr_publication_failed");
});

test("publication distinguishes permission failures from infrastructure failures", async () => {
  for (const scenario of [
    {
      expected: "permission",
      code: "github_http_403",
      error: new GitHubIntegrationError(
        "github_http_403",
        "permission",
        "GitHub rejected the request with HTTP 403.",
      ),
    },
    {
      expected: "infrastructure",
      code: "github_publication_failed",
      error: new Error("network unavailable"),
    },
  ]) {
    const tenant = await seedTenant();
    const runId = await seedPatchRun(tenant);
    const result = await buildPatchResult(tenant);
    await submitPatchResult({ runId, result });
    await approvePatch({
      tenant: tenant.tenantFor("approver"),
      runId,
      patchHash: result.patchSha256,
      intent: "open-draft-pr",
    });

    await assert.rejects(
      publishApprovedPatch({
        tenant: tenant.tenantFor("approver"),
        runId,
        gateway: {
          getBranchSha: async () => tenant.baseSha,
          publishDraftPullRequest: async () => {
            throw scenario.error;
          },
        },
      }),
      scenario.error,
    );
    const failure = await getD1()
      .prepare(
        "SELECT state, failure_category AS category, failure_code AS code FROM migration_runs WHERE id = ?",
      )
      .bind(runId)
      .first<{ state: string; category: string; code: string }>();
    assert.equal(failure?.state, "approved");
    assert.equal(failure?.category, scenario.expected);
    assert.equal(failure?.code, scenario.code);
  }
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
