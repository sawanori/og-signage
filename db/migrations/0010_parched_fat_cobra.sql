CREATE TABLE `member_spotlight_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`request_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`payload` text,
	`photo_file` text,
	`logo_file` text,
	`status` text DEFAULT 'receiving' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`consented_at` integer NOT NULL,
	`consent_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`submitted_at` integer,
	`reviewed_at` integer,
	`reviewed_by` text,
	`approved_spotlight_id` text,
	`cleanup_next_at` integer,
	`cleanup_completed_at` integer,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`approved_spotlight_id`) REFERENCES `member_spotlights`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "member_spotlight_submissions_status_check" CHECK("member_spotlight_submissions"."status" IN ('receiving', 'pending', 'approved', 'rejected', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_spotlight_submissions_request_key_unique` ON `member_spotlight_submissions` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_spotlight_submissions_approved_spotlight_id_unique` ON `member_spotlight_submissions` (`approved_spotlight_id`);--> statement-breakpoint
CREATE INDEX `member_spotlight_submissions_status_submitted_at_idx` ON `member_spotlight_submissions` (`status`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `member_spotlight_submissions_status_updated_at_idx` ON `member_spotlight_submissions` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `member_spotlight_submissions_cleanup_idx` ON `member_spotlight_submissions` (`cleanup_next_at`,`id`) WHERE "member_spotlight_submissions"."status" IN ('rejected', 'expired') AND "member_spotlight_submissions"."cleanup_completed_at" IS NULL;