CREATE TABLE `api_products` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`package_name` text NOT NULL,
	`ecosystem` text DEFAULT 'npm' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_products_org_package_uidx` ON `api_products` (`organization_id`,`package_name`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`run_id` text,
	`campaign_id` text,
	`kind` text NOT NULL,
	`storage_key` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`encryption_key_id` text NOT NULL,
	`lifecycle_state` text DEFAULT 'active' NOT NULL,
	`expires_at` text,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `migration_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_org_storage_key_uidx` ON `artifacts` (`organization_id`,`storage_key`);--> statement-breakpoint
CREATE INDEX `artifacts_expiry_idx` ON `artifacts` (`lifecycle_state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `artifacts_org_run_idx` ON `artifacts` (`organization_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`action` text NOT NULL,
	`actor_membership_id` text,
	`payload` text NOT NULL,
	`previous_hash` text,
	`event_hash` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_aggregate_sequence_uidx` ON `audit_events` (`organization_id`,`aggregate_type`,`aggregate_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_org_hash_uidx` ON `audit_events` (`organization_id`,`event_hash`);--> statement-breakpoint
CREATE INDEX `audit_events_org_occurred_idx` ON `audit_events` (`organization_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `campaign_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_organization_id` text NOT NULL,
	`customer_organization_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`invitation_id` text,
	`lifecycle_status` text DEFAULT 'invited' NOT NULL,
	`share_lifecycle_with_provider` integer DEFAULT false NOT NULL,
	`consented_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`provider_organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invitation_id`) REFERENCES `customer_invitations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_participants_campaign_customer_uidx` ON `campaign_participants` (`campaign_id`,`customer_organization_id`);--> statement-breakpoint
CREATE INDEX `campaign_participants_provider_funnel_idx` ON `campaign_participants` (`provider_organization_id`,`campaign_id`,`share_lifecycle_with_provider`,`lifecycle_status`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`product_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`package_name` text NOT NULL,
	`source_range` text NOT NULL,
	`target_version` text NOT NULL,
	`deadline_at` text,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_spec_id` text,
	`independent_reference` integer DEFAULT false NOT NULL,
	`launched_at` text,
	`completed_at` text,
	`archived_at` text,
	`created_by_membership_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `api_products`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaigns_org_slug_uidx` ON `campaigns` (`organization_id`,`slug`);--> statement-breakpoint
CREATE INDEX `campaigns_org_status_idx` ON `campaigns` (`organization_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `consents` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`repository_migration_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`kind` text NOT NULL,
	`policy_version` text NOT NULL,
	`granted_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_migration_id`) REFERENCES `repository_migrations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `consents_org_migration_kind_idx` ON `consents` (`organization_id`,`repository_migration_id`,`kind`,`granted_at`);--> statement-breakpoint
CREATE TABLE `customer_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_organization_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`customer_organization_id` text,
	`recipient_email` text NOT NULL,
	`token_hash` text NOT NULL,
	`share_policy_version` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` text NOT NULL,
	`accepted_at` text,
	`revoked_at` text,
	`invited_by_membership_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`provider_organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`invited_by_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_invitations_token_hash_unique` ON `customer_invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `customer_invitations_campaign_status_idx` ON `customer_invitations` (`provider_organization_id`,`campaign_id`,`status`);--> statement-breakpoint
CREATE TABLE `deletion_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text NOT NULL,
	`hard_deadline_at` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deletion_jobs_artifact_uidx` ON `deletion_jobs` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `deletion_jobs_status_deadline_idx` ON `deletion_jobs` (`status`,`hard_deadline_at`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`run_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`classification` text NOT NULL,
	`confidence_basis_points` integer NOT NULL,
	`details` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `migration_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `findings_org_run_idx` ON `findings` (`organization_id`,`run_id`,`classification`);--> statement-breakpoint
CREATE TABLE `github_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`app_kind` text NOT NULL,
	`github_installation_id` text NOT NULL,
	`github_account_id` text NOT NULL,
	`github_account_login` text NOT NULL,
	`permissions` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`installed_at` text NOT NULL,
	`suspended_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_installations_app_installation_uidx` ON `github_installations` (`app_kind`,`github_installation_id`);--> statement-breakpoint
CREATE INDEX `github_installations_org_kind_idx` ON `github_installations` (`organization_id`,`app_kind`,`status`);--> statement-breakpoint
CREATE TABLE `github_webhook_deliveries` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`app_kind` text NOT NULL,
	`event_name` text NOT NULL,
	`action` text,
	`installation_id` text,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`processed_at` text,
	`processing_error_code` text
);
--> statement-breakpoint
CREATE INDEX `github_webhook_deliveries_pending_idx` ON `github_webhook_deliveries` (`processed_at`,`received_at`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`workos_user_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_org_user_uidx` ON `memberships` (`organization_id`,`workos_user_id`);--> statement-breakpoint
CREATE INDEX `memberships_org_role_idx` ON `memberships` (`organization_id`,`role`);--> statement-breakpoint
CREATE TABLE `migration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`repository_migration_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`migration_spec_id` text NOT NULL,
	`migration_spec_revision` integer NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`base_sha` text NOT NULL,
	`patch_sha256` text,
	`approved_patch_sha256` text,
	`approved_by_membership_id` text,
	`approved_at` text,
	`trigger_run_id` text,
	`failure_category` text,
	`failure_code` text,
	`manifest` text,
	`manifest_sha256` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`started_at` text,
	`completed_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_migration_id`) REFERENCES `repository_migrations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`migration_spec_id`) REFERENCES `migration_specs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`approved_by_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `migration_runs_org_migration_created_idx` ON `migration_runs` (`organization_id`,`repository_migration_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `migration_runs_org_state_idx` ON `migration_runs` (`organization_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `migration_runs_trigger_run_uidx` ON `migration_runs` (`trigger_run_id`);--> statement-breakpoint
CREATE TABLE `migration_specs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`revision` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`content` text NOT NULL,
	`content_sha256` text NOT NULL,
	`approved_by_membership_id` text,
	`approved_at` text,
	`created_by_membership_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approved_by_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `migration_specs_campaign_revision_uidx` ON `migration_specs` (`campaign_id`,`revision`);--> statement-breakpoint
CREATE INDEX `migration_specs_org_campaign_idx` ON `migration_specs` (`organization_id`,`campaign_id`,`status`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`workos_organization_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`verified_domain` text,
	`provider_branding_approved_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_workos_organization_id_unique` ON `organizations` (`workos_organization_id`);--> statement-breakpoint
CREATE INDEX `organizations_kind_idx` ON `organizations` (`kind`);--> statement-breakpoint
CREATE INDEX `organizations_verified_domain_idx` ON `organizations` (`verified_domain`);--> statement-breakpoint
CREATE TABLE `patches` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`run_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`base_sha` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`integrity_checks` text NOT NULL,
	`approved_at` text,
	`approved_by_membership_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `migration_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`approved_by_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `patches_run_sha_uidx` ON `patches` (`run_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `patches_org_run_idx` ON `patches` (`organization_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`scanner_installation_id` text NOT NULL,
	`patcher_installation_id` text,
	`github_repository_id` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text NOT NULL,
	`selected` integer DEFAULT true NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`last_known_sha` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scanner_installation_id`) REFERENCES `github_installations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`patcher_installation_id`) REFERENCES `github_installations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_org_github_id_uidx` ON `repositories` (`organization_id`,`github_repository_id`);--> statement-breakpoint
CREATE INDEX `repositories_org_selected_idx` ON `repositories` (`organization_id`,`selected`,`archived`);--> statement-breakpoint
CREATE TABLE `repository_migrations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`campaign_participant_id` text NOT NULL,
	`migration_spec_id` text,
	`state` text DEFAULT 'invited' NOT NULL,
	`latest_run_id` text,
	`dependency_version` text,
	`assessment_summary` text,
	`last_failure_category` text,
	`closed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`campaign_participant_id`) REFERENCES `campaign_participants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`migration_spec_id`) REFERENCES `migration_specs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repository_migrations_repo_campaign_uidx` ON `repository_migrations` (`repository_id`,`campaign_id`);--> statement-breakpoint
CREATE INDEX `repository_migrations_org_state_idx` ON `repository_migrations` (`organization_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `source_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`migration_spec_id` text,
	`title` text NOT NULL,
	`source_kind` text NOT NULL,
	`media_type` text NOT NULL,
	`storage_key` text NOT NULL,
	`sha256` text NOT NULL,
	`external_url` text,
	`size_bytes` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`migration_spec_id`) REFERENCES `migration_specs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_artifacts_org_storage_key_uidx` ON `source_artifacts` (`organization_id`,`storage_key`);--> statement-breakpoint
CREATE INDEX `source_artifacts_campaign_idx` ON `source_artifacts` (`organization_id`,`campaign_id`);--> statement-breakpoint
CREATE TABLE `support_access_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`run_id` text NOT NULL,
	`granted_to_membership_id` text NOT NULL,
	`granted_by_membership_id` text NOT NULL,
	`reason` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `migration_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_to_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`granted_by_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `support_access_grants_org_run_idx` ON `support_access_grants` (`organization_id`,`run_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `validation_results` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`run_id` text NOT NULL,
	`category` text NOT NULL,
	`command` text NOT NULL,
	`outcome` text NOT NULL,
	`exit_code` integer,
	`duration_ms` integer NOT NULL,
	`log_artifact_id` text,
	`summary` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `migration_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`log_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `validation_results_org_run_idx` ON `validation_results` (`organization_id`,`run_id`,`category`);