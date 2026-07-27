CREATE TABLE `rate_limit_buckets` (
	`scope_hash` text NOT NULL,
	`operation` text NOT NULL,
	`window_started_at` text NOT NULL,
	`request_count` integer DEFAULT 1 NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_buckets_scope_operation_window_uidx` ON `rate_limit_buckets` (`scope_hash`,`operation`,`window_started_at`);--> statement-breakpoint
CREATE INDEX `rate_limit_buckets_expires_idx` ON `rate_limit_buckets` (`expires_at`);