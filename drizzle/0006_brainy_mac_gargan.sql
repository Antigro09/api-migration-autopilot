CREATE TABLE `workflow_result_receipts` (
	`run_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`response` text,
	`claimed_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `migration_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_result_receipts_org_status_idx` ON `workflow_result_receipts` (`organization_id`,`status`,`claimed_at`);