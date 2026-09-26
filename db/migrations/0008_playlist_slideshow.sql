CREATE TABLE `playlist_item_slides` (
	`id` text PRIMARY KEY NOT NULL,
	`playlist_item_id` text NOT NULL,
	`media_id` text NOT NULL,
	`duration_seconds` integer NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`playlist_item_id`) REFERENCES `playlist_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `playlist_item_slides_item_id_position_idx` ON `playlist_item_slides` (`playlist_item_id`,`position`);--> statement-breakpoint
ALTER TABLE `playlist_items` ADD `kind` text DEFAULT 'video' NOT NULL;