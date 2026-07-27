CREATE TABLE `provider_verification_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`domain` text NOT NULL,
	`dns_name` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` text NOT NULL,
	`verified_at` text,
	`created_by_membership_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_membership_id`) REFERENCES `memberships`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `provider_verification_org_status_idx` ON `provider_verification_challenges` (`organization_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_verification_org_domain_uidx` ON `provider_verification_challenges` (`organization_id`,`domain`);--> statement-breakpoint
ALTER TABLE `source_artifacts` ADD `encryption_key_id` text DEFAULT 'legacy-public-reference' NOT NULL;--> statement-breakpoint
ALTER TABLE `source_artifacts` ADD `extracted_storage_key` text;--> statement-breakpoint
ALTER TABLE `source_artifacts` ADD `extracted_sha256` text;--> statement-breakpoint
ALTER TABLE `source_artifacts` ADD `extracted_encryption_key_id` text;--> statement-breakpoint
ALTER TABLE `source_artifacts` ADD `extraction_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `source_artifacts` ADD `extraction_message` text;--> statement-breakpoint
ALTER TABLE `source_artifacts` ADD `page_count` integer;--> statement-breakpoint
ALTER TABLE `source_artifacts` ADD `uploaded_by_membership_id` text REFERENCES memberships(id);