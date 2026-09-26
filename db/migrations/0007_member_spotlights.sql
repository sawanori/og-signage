CREATE TABLE `member_spotlights` (
	`id` text PRIMARY KEY NOT NULL,
	`company_name` text NOT NULL,
	`person_name` text NOT NULL,
	`role` text,
	`quote` text,
	`bio` text,
	`tags` text NOT NULL,
	`photo_media_id` text,
	`logo_media_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`photo_media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`logo_media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE restrict
);
