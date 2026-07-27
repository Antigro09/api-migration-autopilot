CREATE TABLE `operational_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`run_id` text,
	`severity` text NOT NULL,
	`code` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`first_occurred_at` text NOT NULL,
	`last_occurred_at` text NOT NULL,
	`acknowledged_by_membership_id` text,
	`acknowledged_at` text,
	`resolved_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `migration_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`acknowledged_by_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `operational_alerts_status_severity_idx` ON `operational_alerts` (`status`,`severity`,`last_occurred_at`);--> statement-breakpoint
CREATE INDEX `operational_alerts_org_run_idx` ON `operational_alerts` (`organization_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `patch_review_files` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`run_id` text NOT NULL,
	`patch_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`path` text NOT NULL,
	`additions` integer NOT NULL,
	`deletions` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `migration_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`patch_id`) REFERENCES `patches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `patch_review_files_patch_path_uidx` ON `patch_review_files` (`patch_id`,`path`);--> statement-breakpoint
CREATE INDEX `patch_review_files_org_run_idx` ON `patch_review_files` (`organization_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `support_access_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`run_id` text NOT NULL,
	`requested_by_membership_id` text NOT NULL,
	`reason` text NOT NULL,
	`requested_duration_minutes` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolved_by_membership_id` text,
	`grant_id` text,
	`resolved_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `migration_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`resolved_by_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`grant_id`) REFERENCES `support_access_grants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `support_access_requests_org_status_idx` ON `support_access_requests` (`organization_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `support_access_requests_requester_status_idx` ON `support_access_requests` (`requested_by_membership_id`,`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `migration_runs` ADD `retry_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `migration_runs` ADD `retry_of_run_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `migration_runs_retry_source_uidx` ON `migration_runs` (`retry_of_run_id`);