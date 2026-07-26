CREATE TABLE `run_stage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`detail` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `migration_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_stage_events_run_sequence_uidx` ON `run_stage_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `run_stage_events_org_run_idx` ON `run_stage_events` (`organization_id`,`run_id`,`occurred_at`);--> statement-breakpoint
ALTER TABLE `artifacts` ADD `deletion_verified_at` text;--> statement-breakpoint
ALTER TABLE `deletion_jobs` ADD `next_attempt_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL;--> statement-breakpoint
ALTER TABLE `deletion_jobs` ADD `storage_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `deletion_jobs_status_attempt_idx` ON `deletion_jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
ALTER TABLE `migration_runs` ADD `kind` text DEFAULT 'assessment' NOT NULL;--> statement-breakpoint
ALTER TABLE `migration_runs` ADD `merge_commit_sha` text;--> statement-breakpoint
ALTER TABLE `migration_runs` ADD `verification_run_id` text;--> statement-breakpoint
ALTER TABLE `migration_runs` ADD `cost_micro_usd` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `repository_migrations` ADD `verified_at` text;