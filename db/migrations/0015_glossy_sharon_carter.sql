CREATE TABLE `company_research_outbox` (
	`event_id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`event_type` text NOT NULL,
	`urls_json` text NOT NULL,
	`url_fingerprint` text NOT NULL,
	`occurred_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`last_error_code` text,
	`delivered_at` integer,
	CONSTRAINT "company_research_outbox_event_type_check" CHECK("company_research_outbox"."event_type" IN ('upsert', 'revoke', 'delete')),
	CONSTRAINT "company_research_outbox_status_check" CHECK("company_research_outbox"."status" IN ('pending', 'delivering', 'delivered', 'blocked')),
	CONSTRAINT "company_research_outbox_revision_check" CHECK("company_research_outbox"."source_revision" >= 0),
	CONSTRAINT "company_research_outbox_attempts_check" CHECK("company_research_outbox"."attempts" >= 0),
	CONSTRAINT "company_research_outbox_urls_check" CHECK(json_valid("company_research_outbox"."urls_json") AND json_type("company_research_outbox"."urls_json") = 'array' AND (( "company_research_outbox"."event_type" = 'upsert' AND json_array_length("company_research_outbox"."urls_json") BETWEEN 1 AND 2) OR ("company_research_outbox"."event_type" IN ('revoke', 'delete') AND json_array_length("company_research_outbox"."urls_json") = 0)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_research_outbox_source_revision_type_idx` ON `company_research_outbox` (`source_id`,`source_revision`,`event_type`);--> statement-breakpoint
CREATE INDEX `company_research_outbox_delivery_idx` ON `company_research_outbox` (`status`,`next_attempt_at`,`lease_expires_at`);