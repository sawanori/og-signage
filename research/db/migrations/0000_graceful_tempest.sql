CREATE TABLE `research_controls` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `research_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`payload_hash` text NOT NULL,
	`source_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`event_type` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `research_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`generation` integer NOT NULL,
	`url_fingerprint` text NOT NULL,
	`urls_json` text NOT NULL,
	`phase` text DEFAULT 'crawl' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress_json` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_run_at` integer NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`source_id`) REFERENCES `research_subjects`(`source_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_jobs_generation_unique` ON `research_jobs` (`source_id`,`generation`);--> statement-breakpoint
CREATE INDEX `research_jobs_due_idx` ON `research_jobs` (`status`,`next_run_at`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `research_pages` (
	`page_id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`source_id` text NOT NULL,
	`canonical_url` text NOT NULL,
	`content_hash` text,
	`markdown_key` text,
	`raw_key` text,
	`title` text,
	`status` text NOT NULL,
	`exclusion_reason` text,
	`fetched_at` integer NOT NULL,
	`raw_expires_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `research_jobs`(`job_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_pages_url_unique` ON `research_pages` (`job_id`,`canonical_url`);--> statement-breakpoint
CREATE INDEX `research_pages_raw_expiry_idx` ON `research_pages` (`raw_expires_at`);--> statement-breakpoint
CREATE TABLE `research_profiles` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`job_id` text NOT NULL,
	`generation` integer NOT NULL,
	`content_hash` text NOT NULL,
	`schema_version` integer NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`payload_json` text NOT NULL,
	`extracted_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `research_jobs`(`job_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_profiles_generation_unique` ON `research_profiles` (`source_id`,`generation`);--> statement-breakpoint
CREATE TABLE `research_subjects` (
	`source_id` text PRIMARY KEY NOT NULL,
	`source_revision` integer NOT NULL,
	`url_fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`current_job_id` text,
	`current_profile_id` text,
	`last_successful_crawl_at` integer,
	`purge_after` integer,
	`purged_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_subjects_purge_idx` ON `research_subjects` (`purge_after`);--> statement-breakpoint
CREATE TABLE `research_usage` (
	`reservation_id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`operation_key` text NOT NULL,
	`provider` text NOT NULL,
	`month` text NOT NULL,
	`status` text NOT NULL,
	`reserved_microusd` integer NOT NULL,
	`charged_microusd` integer NOT NULL,
	`input_token_limit` integer DEFAULT 0 NOT NULL,
	`output_token_limit` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cached_tokens` integer,
	`reasoning_tokens` integer,
	`price_version` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `research_jobs`(`job_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "research_usage_nonnegative" CHECK("research_usage"."reserved_microusd" >= 0 AND "research_usage"."charged_microusd" >= 0 AND "research_usage"."input_token_limit" >= 0 AND "research_usage"."output_token_limit" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_usage_operation_unique` ON `research_usage` (`job_id`,`operation_key`);--> statement-breakpoint
CREATE INDEX `research_usage_month_idx` ON `research_usage` (`provider`,`month`);