import { getD1 } from "@/db";
import { ensureDatabaseSchema } from "@/db/runtime";
import { appendAuditEvent } from "@/lib/data/control-plane";
import { domainChange } from "@/lib/data/specs";
import {
  parseMigrationSpecV1,
  sha256Hex,
  type MigrationSpecV1,
  type OrganizationRole,
  type RepositoryMigrationState,
  type TenantContext,
} from "@/lib/domain";
import { stripeV20ToV22Spec } from "@/lib/migration/specs/stripe-v20-v22";

export type SeededTenant = {
  providerOrganizationId: string;
  providerMembershipId: string;
  customerOrganizationId: string;
  campaignId: string;
  specId: string;
  repositoryId: string;
  repositoryMigrationId: string;
  assessmentRunId: string;
  participantId: string;
  scannerInstallationId: string;
  patcherInstallationId: string;
  baseSha: string;
  memberships: Record<OrganizationRole, string>;
  tenantFor(role: OrganizationRole): TenantContext;
};

let counter = 0;

function id(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(16).padStart(8, "0")}${"0".repeat(24)}`;
}

const ARTIFACT_IDS = new Map<string, string>([
  ["stripe-node-changelog", "stripe-node-changelog"],
  ["stripe-node-v21-guide", "stripe-node-v21-guide"],
  ["stripe-node-v22-guide", "stripe-node-v22-guide"],
  ["stripe-api-dahlia", "stripe-api-dahlia"],
]);

function referenceSpec(input: {
  specId: string;
  organizationId: string;
  campaignId: string;
  approvedByMembershipId: string;
}): MigrationSpecV1 {
  return parseMigrationSpecV1({
    schemaVersion: "1",
    id: input.specId,
    organizationId: input.organizationId,
    campaignId: input.campaignId,
    revision: 1,
    status: "approved",
    approvedAt: new Date().toISOString(),
    approvedByMembershipId: input.approvedByMembershipId,
    providerName: "Independent Stripe reference",
    productName: "stripe-node",
    package: {
      ecosystem: "npm",
      name: "stripe",
      language: "typescript",
      sourceRange: ">=20.3.0 <21.0.0",
      targetVersion: "22.1.0",
    },
    sourceArtifacts: [...ARTIFACT_IDS.keys()].map((artifactId) => ({
      id: artifactId,
      title: artifactId,
      kind: "markdown",
      mediaType: "text/markdown",
      sha256: "0".repeat(64),
      externalUrl: `https://example.test/${artifactId}`,
    })),
    changes: stripeV20ToV22Spec.changes.map((change) =>
      domainChange(change, ARTIFACT_IDS),
    ),
    generalLimitations: [
      "Independent public reference; the provider has not sponsored this campaign.",
    ],
    createdAt: new Date().toISOString(),
  });
}

/**
 * Seeds a complete provider → customer → repository graph the way the real
 * flows leave it: live campaign, approved spec, accepted invitation, active
 * Scanner and Patcher installations, and a completed assessment whose findings
 * authorize exactly one path.
 */
export async function seedTenant(options?: {
  migrationState?: RepositoryMigrationState;
  shareLifecycle?: boolean;
  patcherActive?: boolean;
  affectedPaths?: readonly string[];
  autoPatchEligible?: boolean;
}): Promise<SeededTenant> {
  await ensureDatabaseSchema();
  const database = getD1();

  const providerOrganizationId = id("org");
  const providerMembershipId = id("mem");
  const customerOrganizationId = id("org");
  const memberships: Record<OrganizationRole, string> = {
    admin: id("mem"),
    operator: id("mem"),
    approver: id("mem"),
    viewer: id("mem"),
  };
  const productId = id("prd");
  const campaignId = id("cmp");
  const specId = id("spc");
  const invitationId = id("inv");
  const participantId = id("cpt");
  const scannerInstallationId = id("ghi");
  const patcherInstallationId = id("ghi");
  const installationBase = 5_000 + counter * 10;
  const repositoryId = id("repo");
  const repositoryMigrationId = id("rmg");
  const assessmentRunId = id("run");
  const baseSha = "a".repeat(40);
  const now = new Date().toISOString();
  const spec = referenceSpec({
    specId,
    organizationId: providerOrganizationId,
    campaignId,
    approvedByMembershipId: providerMembershipId,
  });
  const affectedPaths = options?.affectedPaths ?? ["src/billing.ts"];

  const statements = [
    database
      .prepare(
        "INSERT INTO organizations (id, workos_organization_id, name, kind) VALUES (?, ?, ?, 'provider')",
      )
      .bind(providerOrganizationId, `siwc:${providerOrganizationId}`, "Provider Inc"),
    database
      .prepare(
        "INSERT INTO organizations (id, workos_organization_id, name, kind) VALUES (?, ?, ?, 'customer')",
      )
      .bind(customerOrganizationId, `siwc:${customerOrganizationId}`, "Customer Ltd"),
    database
      .prepare(
        "INSERT INTO memberships (id, organization_id, workos_user_id, role, status) VALUES (?, ?, ?, 'admin', 'active')",
      )
      .bind(
        providerMembershipId,
        providerOrganizationId,
        `siwc:provider-${providerOrganizationId}`,
      ),
    ...(Object.entries(memberships) as Array<[OrganizationRole, string]>).map(
      ([role, membershipId]) =>
        database
          .prepare(
            "INSERT INTO memberships (id, organization_id, workos_user_id, role, status) VALUES (?, ?, ?, ?, 'active')",
          )
          .bind(
            membershipId,
            customerOrganizationId,
            `siwc:${role}-${customerOrganizationId}`,
            role,
          ),
    ),
    database
      .prepare(
        "INSERT INTO api_products (id, organization_id, name, package_name, ecosystem) VALUES (?, ?, 'stripe-node', 'stripe', 'npm')",
      )
      .bind(productId, providerOrganizationId),
    database
      .prepare(
        `INSERT INTO campaigns (
          id, organization_id, product_id, slug, name, package_name,
          source_range, target_version, notes, status, current_spec_id,
          independent_reference, created_by_membership_id
        ) VALUES (?, ?, ?, 'stripe-22-ref', 'Stripe 20 to 22', 'stripe',
                  '>=20.3.0 <21.0.0', '22.1.0', '', 'live', ?, true, ?)`,
      )
      .bind(
        campaignId,
        providerOrganizationId,
        productId,
        specId,
        providerMembershipId,
      ),
    database
      .prepare(
        `INSERT INTO migration_specs (
          id, organization_id, campaign_id, revision, status, content,
          content_sha256, approved_by_membership_id, approved_at,
          created_by_membership_id
        ) VALUES (?, ?, ?, 1, 'approved', ?, ?, ?, ?, ?)`,
      )
      .bind(
        specId,
        providerOrganizationId,
        campaignId,
        JSON.stringify(spec),
        await sha256Hex(JSON.stringify(spec)),
        providerMembershipId,
        now,
        providerMembershipId,
      ),
    database
      .prepare(
        `INSERT INTO customer_invitations (
          id, provider_organization_id, campaign_id, customer_organization_id,
          recipient_email, token_hash, share_policy_version, status,
          expires_at, accepted_at, invited_by_membership_id
        ) VALUES (?, ?, ?, ?, 'approver@customer.test', ?, 'consented-lifecycle-v1',
                  'accepted', ?, ?, ?)`,
      )
      .bind(
        invitationId,
        providerOrganizationId,
        campaignId,
        customerOrganizationId,
        `hash-${invitationId}`,
        new Date(Date.now() + 86_400_000).toISOString(),
        now,
        providerMembershipId,
      ),
    database
      .prepare(
        `INSERT INTO campaign_participants (
          id, provider_organization_id, customer_organization_id, campaign_id,
          invitation_id, lifecycle_status, share_lifecycle_with_provider,
          consented_at
        ) VALUES (?, ?, ?, ?, ?, 'connected', ?, ?)`,
      )
      .bind(
        participantId,
        providerOrganizationId,
        customerOrganizationId,
        campaignId,
        invitationId,
        options?.shareLifecycle ?? true,
        now,
      ),
    database
      .prepare(
        `INSERT INTO github_installations (
          id, organization_id, app_kind, github_installation_id,
          github_account_id, github_account_login, permissions, status, installed_at
        ) VALUES (?, ?, 'scanner', ?, ?, 'customer-org', '{}', 'active', ?)`,
      )
      .bind(
        scannerInstallationId,
        customerOrganizationId,
        String(installationBase + 1),
        String(installationBase),
        now,
      ),
    database
      .prepare(
        `INSERT INTO github_installations (
          id, organization_id, app_kind, github_installation_id,
          github_account_id, github_account_login, permissions, status, installed_at
        ) VALUES (?, ?, 'patcher', ?, ?, 'customer-org', '{}', ?, ?)`,
      )
      .bind(
        patcherInstallationId,
        customerOrganizationId,
        String(installationBase + 2),
        String(installationBase),
        options?.patcherActive === false ? "revoked" : "active",
        now,
      ),
    database
      .prepare(
        `INSERT INTO repositories (
          id, organization_id, scanner_installation_id, patcher_installation_id,
          github_repository_id, owner, name, default_branch, selected, archived,
          last_known_sha
        ) VALUES (?, ?, ?, ?, ?, 'customer-org', 'billing-service', 'main', true, false, ?)`,
      )
      .bind(
        repositoryId,
        customerOrganizationId,
        scannerInstallationId,
        patcherInstallationId,
        String(77_000 + counter),
        baseSha,
      ),
    database
      .prepare(
        `INSERT INTO repository_migrations (
          id, organization_id, repository_id, campaign_id,
          campaign_participant_id, migration_spec_id, state, latest_run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        repositoryMigrationId,
        customerOrganizationId,
        repositoryId,
        campaignId,
        participantId,
        specId,
        options?.migrationState ?? "impact_found",
        assessmentRunId,
      ),
    database
      .prepare(
        `INSERT INTO migration_runs (
          id, organization_id, repository_migration_id, repository_id,
          campaign_id, migration_spec_id, migration_spec_revision,
          state, base_sha, kind, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 'cleaned', ?, 'assessment', ?)`,
      )
      .bind(
        assessmentRunId,
        customerOrganizationId,
        repositoryMigrationId,
        repositoryId,
        campaignId,
        specId,
        baseSha,
        now,
      ),
    ...affectedPaths.map((path, index) =>
      database
        .prepare(
          `INSERT INTO findings (
            id, organization_id, run_id, rule_id, classification,
            confidence_basis_points, details
          ) VALUES (?, ?, ?, 'stripe.constructor.new', 'affected', 10000, ?)`,
        )
        .bind(
          id("fnd"),
          customerOrganizationId,
          assessmentRunId,
          JSON.stringify({
            path,
            location: { start: 0, end: 6, line: 1, column: 1 },
            message: "Construct the v22 client with new.",
            autoPatchEligible: options?.autoPatchEligible ?? true,
            evidence: [
              {
                title: "stripe-node v22 migration guide",
                url: "https://example.test/stripe-node-v22-guide",
              },
            ],
            index,
          }),
        ),
    ),
  ];
  await database.batch(statements);

  return {
    providerOrganizationId,
    providerMembershipId,
    customerOrganizationId,
    campaignId,
    specId,
    repositoryId,
    repositoryMigrationId,
    assessmentRunId,
    participantId,
    scannerInstallationId,
    patcherInstallationId,
    baseSha,
    memberships,
    tenantFor(role: OrganizationRole): TenantContext {
      return {
        organizationId: customerOrganizationId,
        membershipId: memberships[role],
        userId: `usr_${role}`,
        role,
        organizationKind: "customer",
      };
    },
  };
}

/**
 * Inserts a patch run in the state the durable workflow would have left it in
 * just before submitting its result.
 */
export async function seedPatchRun(
  tenant: SeededTenant,
  options?: { state?: string; migrationState?: RepositoryMigrationState },
): Promise<string> {
  const runId = id("run");
  await getD1()
    .prepare(
      `INSERT INTO migration_runs (
        id, organization_id, repository_migration_id, repository_id,
        campaign_id, migration_spec_id, migration_spec_revision,
        state, base_sha, kind
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'patch')`,
    )
    .bind(
      runId,
      tenant.customerOrganizationId,
      tenant.repositoryMigrationId,
      tenant.repositoryId,
      tenant.campaignId,
      tenant.specId,
      options?.state ?? "generating",
      tenant.baseSha,
    )
    .run();
  await getD1()
    .prepare(
      "UPDATE repository_migrations SET state = ?, latest_run_id = ? WHERE id = ?",
    )
    .bind(
      options?.migrationState ?? "generating",
      runId,
      tenant.repositoryMigrationId,
    )
    .run();
  // Every run needs an audit chain before a manifest can anchor to it.
  await appendAuditEvent({
    organizationId: tenant.customerOrganizationId,
    aggregateType: "run",
    aggregateId: runId,
    action: "patch.requested",
    actorMembershipId: tenant.memberships.approver,
    payload: { baseSha: tenant.baseSha },
  });
  return runId;
}
