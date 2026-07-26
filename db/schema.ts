import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  ArtifactKind,
  ArtifactLifecycleState,
  CampaignState,
  InvitationState,
  MigrationSpecV1,
  RepositoryMigrationState,
  RunManifestV1,
  RunStage,
  RunState,
  ValidationOutcome,
} from "../lib/domain";
import type {
  JsonObject,
  OrganizationKind,
  OrganizationRole,
} from "../lib/domain";

const currentTimestamp = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    workosOrganizationId: text("workos_organization_id").notNull().unique(),
    name: text("name").notNull(),
    kind: text("kind").$type<OrganizationKind>().notNull(),
    verifiedDomain: text("verified_domain"),
    providerBrandingApprovedAt: text("provider_branding_approved_at"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("organizations_kind_idx").on(table.kind),
    index("organizations_verified_domain_idx").on(table.verifiedDomain),
  ],
);

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workosUserId: text("workos_user_id").notNull(),
    role: text("role").$type<OrganizationRole>().notNull(),
    status: text("status")
      .$type<"active" | "suspended" | "removed">()
      .notNull()
      .default("active"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("memberships_org_user_uidx").on(
      table.organizationId,
      table.workosUserId,
    ),
    index("memberships_org_role_idx").on(table.organizationId, table.role),
  ],
);

export const apiProducts = sqliteTable(
  "api_products",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    packageName: text("package_name").notNull(),
    ecosystem: text("ecosystem").notNull().default("npm"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("api_products_org_package_uidx").on(
      table.organizationId,
      table.packageName,
    ),
  ],
);

export const campaigns = sqliteTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => apiProducts.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    packageName: text("package_name").notNull(),
    sourceRange: text("source_range").notNull(),
    targetVersion: text("target_version").notNull(),
    deadlineAt: text("deadline_at"),
    notes: text("notes").notNull().default(""),
    status: text("status").$type<CampaignState>().notNull().default("draft"),
    currentSpecId: text("current_spec_id"),
    independentReference: integer("independent_reference", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    launchedAt: text("launched_at"),
    completedAt: text("completed_at"),
    archivedAt: text("archived_at"),
    createdByMembershipId: text("created_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("campaigns_org_slug_uidx").on(
      table.organizationId,
      table.slug,
    ),
    index("campaigns_org_status_idx").on(
      table.organizationId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const migrationSpecs = sqliteTable(
  "migration_specs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    status: text("status")
      .$type<"draft" | "approved" | "superseded">()
      .notNull()
      .default("draft"),
    content: text("content", { mode: "json" }).$type<MigrationSpecV1>().notNull(),
    contentSha256: text("content_sha256").notNull(),
    approvedByMembershipId: text("approved_by_membership_id").references(
      () => memberships.id,
      { onDelete: "restrict" },
    ),
    approvedAt: text("approved_at"),
    createdByMembershipId: text("created_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("migration_specs_campaign_revision_uidx").on(
      table.campaignId,
      table.revision,
    ),
    index("migration_specs_org_campaign_idx").on(
      table.organizationId,
      table.campaignId,
      table.status,
    ),
  ],
);

export const sourceArtifacts = sqliteTable(
  "source_artifacts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    migrationSpecId: text("migration_spec_id").references(
      () => migrationSpecs.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    sourceKind: text("source_kind").notNull(),
    mediaType: text("media_type").notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    externalUrl: text("external_url"),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("source_artifacts_org_storage_key_uidx").on(
      table.organizationId,
      table.storageKey,
    ),
    index("source_artifacts_campaign_idx").on(
      table.organizationId,
      table.campaignId,
    ),
  ],
);

export const customerInvitations = sqliteTable(
  "customer_invitations",
  {
    id: text("id").primaryKey(),
    providerOrganizationId: text("provider_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    customerOrganizationId: text("customer_organization_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    recipientEmail: text("recipient_email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    sharePolicyVersion: text("share_policy_version").notNull(),
    status: text("status")
      .$type<InvitationState>()
      .notNull()
      .default("pending"),
    expiresAt: text("expires_at").notNull(),
    acceptedAt: text("accepted_at"),
    revokedAt: text("revoked_at"),
    invitedByMembershipId: text("invited_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("customer_invitations_campaign_status_idx").on(
      table.providerOrganizationId,
      table.campaignId,
      table.status,
    ),
  ],
);

export const campaignParticipants = sqliteTable(
  "campaign_participants",
  {
    id: text("id").primaryKey(),
    providerOrganizationId: text("provider_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerOrganizationId: text("customer_organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    invitationId: text("invitation_id").references(() => customerInvitations.id, {
      onDelete: "set null",
    }),
    lifecycleStatus: text("lifecycle_status")
      .$type<
        | "invited"
        | "connected"
        | "assessed"
        | "affected"
        | "patch_requested"
        | "pr_opened"
        | "merged"
        | "verified"
      >()
      .notNull()
      .default("invited"),
    shareLifecycleWithProvider: integer("share_lifecycle_with_provider", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    consentedAt: text("consented_at"),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("campaign_participants_campaign_customer_uidx").on(
      table.campaignId,
      table.customerOrganizationId,
    ),
    index("campaign_participants_provider_funnel_idx").on(
      table.providerOrganizationId,
      table.campaignId,
      table.shareLifecycleWithProvider,
      table.lifecycleStatus,
    ),
  ],
);

export const githubInstallations = sqliteTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appKind: text("app_kind").$type<"scanner" | "patcher">().notNull(),
    githubInstallationId: text("github_installation_id").notNull(),
    githubAccountId: text("github_account_id").notNull(),
    githubAccountLogin: text("github_account_login").notNull(),
    permissions: text("permissions", { mode: "json" })
      .$type<JsonObject>()
      .notNull(),
    status: text("status")
      .$type<"active" | "suspended" | "revoked">()
      .notNull()
      .default("active"),
    installedAt: text("installed_at").notNull(),
    suspendedAt: text("suspended_at"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("github_installations_app_installation_uidx").on(
      table.appKind,
      table.githubInstallationId,
    ),
    index("github_installations_org_kind_idx").on(
      table.organizationId,
      table.appKind,
      table.status,
    ),
  ],
);

export const repositories = sqliteTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scannerInstallationId: text("scanner_installation_id")
      .notNull()
      .references(() => githubInstallations.id, { onDelete: "restrict" }),
    patcherInstallationId: text("patcher_installation_id").references(
      () => githubInstallations.id,
      { onDelete: "set null" },
    ),
    githubRepositoryId: text("github_repository_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    selected: integer("selected", { mode: "boolean" })
      .notNull()
      .default(true),
    archived: integer("archived", { mode: "boolean" })
      .notNull()
      .default(false),
    lastKnownSha: text("last_known_sha"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("repositories_org_github_id_uidx").on(
      table.organizationId,
      table.githubRepositoryId,
    ),
    index("repositories_org_selected_idx").on(
      table.organizationId,
      table.selected,
      table.archived,
    ),
  ],
);

export const repositoryMigrations = sqliteTable(
  "repository_migrations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "restrict" }),
    campaignParticipantId: text("campaign_participant_id")
      .notNull()
      .references(() => campaignParticipants.id, { onDelete: "restrict" }),
    migrationSpecId: text("migration_spec_id").references(
      () => migrationSpecs.id,
      { onDelete: "restrict" },
    ),
    state: text("state")
      .$type<RepositoryMigrationState>()
      .notNull()
      .default("invited"),
    latestRunId: text("latest_run_id"),
    dependencyVersion: text("dependency_version"),
    assessmentSummary: text("assessment_summary", { mode: "json" }).$type<
      JsonObject | null
    >(),
    lastFailureCategory: text("last_failure_category").$type<
      | "code"
      | "infrastructure"
      | "permission"
      | "stale_base"
      | "unsupported"
      | null
    >(),
    verifiedAt: text("verified_at"),
    closedAt: text("closed_at"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("repository_migrations_repo_campaign_uidx").on(
      table.repositoryId,
      table.campaignId,
    ),
    index("repository_migrations_org_state_idx").on(
      table.organizationId,
      table.state,
      table.updatedAt,
    ),
  ],
);

export const consents = sqliteTable(
  "consents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryMigrationId: text("repository_migration_id")
      .notNull()
      .references(() => repositoryMigrations.id, { onDelete: "cascade" }),
    membershipId: text("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    kind: text("kind")
      .$type<"provider_lifecycle_sharing" | "external_model_processing">()
      .notNull(),
    policyVersion: text("policy_version").notNull(),
    grantedAt: text("granted_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("consents_org_migration_kind_idx").on(
      table.organizationId,
      table.repositoryMigrationId,
      table.kind,
      table.grantedAt,
    ),
  ],
);

export const migrationRuns = sqliteTable(
  "migration_runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryMigrationId: text("repository_migration_id")
      .notNull()
      .references(() => repositoryMigrations.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "restrict" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "restrict" }),
    migrationSpecId: text("migration_spec_id")
      .notNull()
      .references(() => migrationSpecs.id, { onDelete: "restrict" }),
    migrationSpecRevision: integer("migration_spec_revision").notNull(),
    state: text("state").$type<RunState>().notNull().default("queued"),
    baseSha: text("base_sha").notNull(),
    patchSha256: text("patch_sha256"),
    approvedPatchSha256: text("approved_patch_sha256"),
    approvedByMembershipId: text("approved_by_membership_id").references(
      () => memberships.id,
      { onDelete: "restrict" },
    ),
    approvedAt: text("approved_at"),
    triggerRunId: text("trigger_run_id"),
    failureCategory: text("failure_category").$type<
      | "code"
      | "infrastructure"
      | "permission"
      | "stale_base"
      | "unsupported"
      | null
    >(),
    failureCode: text("failure_code"),
    manifest: text("manifest", { mode: "json" }).$type<RunManifestV1 | null>(),
    manifestSha256: text("manifest_sha256"),
    kind: text("kind")
      .$type<"assessment" | "patch" | "verification">()
      .notNull()
      .default("assessment"),
    mergeCommitSha: text("merge_commit_sha"),
    verificationRunId: text("verification_run_id"),
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("migration_runs_org_migration_created_idx").on(
      table.organizationId,
      table.repositoryMigrationId,
      table.createdAt,
    ),
    index("migration_runs_org_state_idx").on(
      table.organizationId,
      table.state,
      table.updatedAt,
    ),
    uniqueIndex("migration_runs_trigger_run_uidx").on(table.triggerRunId),
  ],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => migrationRuns.id, {
      onDelete: "cascade",
    }),
    campaignId: text("campaign_id").references(() => campaigns.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").$type<ArtifactKind>().notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    encryptionKeyId: text("encryption_key_id").notNull(),
    lifecycleState: text("lifecycle_state")
      .$type<ArtifactLifecycleState>()
      .notNull()
      .default("active"),
    expiresAt: text("expires_at"),
    deletedAt: text("deleted_at"),
    deletionVerifiedAt: text("deletion_verified_at"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("artifacts_org_storage_key_uidx").on(
      table.organizationId,
      table.storageKey,
    ),
    index("artifacts_expiry_idx").on(table.lifecycleState, table.expiresAt),
    index("artifacts_org_run_idx").on(table.organizationId, table.runId),
  ],
);

export const findings = sqliteTable(
  "findings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    classification: text("classification")
      .$type<"affected" | "not_affected" | "uncertain" | "unsupported">()
      .notNull(),
    confidence: integer("confidence_basis_points").notNull(),
    details: text("details", { mode: "json" }).$type<JsonObject>().notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("findings_org_run_idx").on(
      table.organizationId,
      table.runId,
      table.classification,
    ),
  ],
);

export const patches = sqliteTable(
  "patches",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "restrict" }),
    baseSha: text("base_sha").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    integrityChecks: text("integrity_checks", { mode: "json" })
      .$type<JsonObject>()
      .notNull(),
    approvedAt: text("approved_at"),
    approvedByMembershipId: text("approved_by_membership_id").references(
      () => memberships.id,
      { onDelete: "restrict" },
    ),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("patches_run_sha_uidx").on(table.runId, table.sha256),
    index("patches_org_run_idx").on(table.organizationId, table.runId),
  ],
);

export const validationResults = sqliteTable(
  "validation_results",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    category: text("category")
      .$type<"install" | "lint" | "typecheck" | "build" | "test">()
      .notNull(),
    command: text("command").notNull(),
    outcome: text("outcome").$type<ValidationOutcome>().notNull(),
    exitCode: integer("exit_code"),
    durationMs: integer("duration_ms").notNull(),
    logArtifactId: text("log_artifact_id").references(() => artifacts.id, {
      onDelete: "set null",
    }),
    summary: text("summary").notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("validation_results_org_run_idx").on(
      table.organizationId,
      table.runId,
      table.category,
    ),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    sequence: integer("sequence").notNull(),
    action: text("action").notNull(),
    actorMembershipId: text("actor_membership_id").references(
      () => memberships.id,
      { onDelete: "restrict" },
    ),
    payload: text("payload", { mode: "json" }).$type<JsonObject>().notNull(),
    previousHash: text("previous_hash"),
    eventHash: text("event_hash").notNull(),
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("audit_events_aggregate_sequence_uidx").on(
      table.organizationId,
      table.aggregateType,
      table.aggregateId,
      table.sequence,
    ),
    uniqueIndex("audit_events_org_hash_uidx").on(
      table.organizationId,
      table.eventHash,
    ),
    index("audit_events_org_occurred_idx").on(
      table.organizationId,
      table.occurredAt,
    ),
  ],
);

export const githubWebhookDeliveries = sqliteTable(
  "github_webhook_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    appKind: text("app_kind").$type<"scanner" | "patcher">().notNull(),
    eventName: text("event_name").notNull(),
    action: text("action"),
    installationId: text("installation_id"),
    receivedAt: text("received_at").notNull().default(currentTimestamp),
    processedAt: text("processed_at"),
    processingErrorCode: text("processing_error_code"),
  },
  (table) => [
    index("github_webhook_deliveries_pending_idx").on(
      table.processedAt,
      table.receivedAt,
    ),
  ],
);

export const deletionJobs = sqliteTable(
  "deletion_jobs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<"pending" | "running" | "completed" | "failed">()
      .notNull()
      .default("pending"),
    reason: text("reason")
      .$type<"run_completed" | "retention_expired" | "customer_request">()
      .notNull(),
    hardDeadlineAt: text("hard_deadline_at").notNull(),
    nextAttemptAt: text("next_attempt_at").notNull().default(currentTimestamp),
    storageKey: text("storage_key").notNull().default(""),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
    updatedAt: text("updated_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("deletion_jobs_artifact_uidx").on(table.artifactId),
    index("deletion_jobs_status_deadline_idx").on(
      table.status,
      table.hardDeadlineAt,
    ),
    index("deletion_jobs_status_attempt_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
  ],
);

export const runStageEvents = sqliteTable(
  "run_stage_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    stage: text("stage").$type<RunStage>().notNull(),
    status: text("status")
      .$type<"started" | "completed" | "skipped" | "failed">()
      .notNull(),
    detail: text("detail", { mode: "json" }).$type<JsonObject>().notNull(),
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    uniqueIndex("run_stage_events_run_sequence_uidx").on(
      table.runId,
      table.sequence,
    ),
    index("run_stage_events_org_run_idx").on(
      table.organizationId,
      table.runId,
      table.occurredAt,
    ),
  ],
);

export const supportAccessGrants = sqliteTable(
  "support_access_grants",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    grantedToMembershipId: text("granted_to_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    grantedByMembershipId: text("granted_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(currentTimestamp),
  },
  (table) => [
    index("support_access_grants_org_run_idx").on(
      table.organizationId,
      table.runId,
      table.expiresAt,
    ),
  ],
);
