ALTER TABLE `migration_specs` ADD `submitted_for_review_at` text;--> statement-breakpoint
ALTER TABLE `provider_verification_challenges` ADD `verification_value` text NOT NULL;