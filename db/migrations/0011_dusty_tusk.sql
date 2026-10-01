ALTER TABLE `member_spotlight_submissions` ADD `contact_email` text;--> statement-breakpoint
ALTER TABLE `member_spotlight_submissions` ADD `notification_status` text;--> statement-breakpoint
ALTER TABLE `member_spotlight_submissions` ADD `notification_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `member_spotlight_submissions` ADD `notified_at` integer;--> statement-breakpoint
ALTER TABLE `member_spotlight_submissions` ADD `notification_next_at` integer;--> statement-breakpoint
ALTER TABLE `member_spotlight_submissions` ADD `notification_name` text;--> statement-breakpoint
CREATE INDEX `member_spotlight_submissions_notification_idx` ON `member_spotlight_submissions` (`notification_next_at`,`id`) WHERE "member_spotlight_submissions"."notification_status" = 'pending';