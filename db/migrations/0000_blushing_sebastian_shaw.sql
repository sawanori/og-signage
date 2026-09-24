CREATE TABLE `device_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`type` text NOT NULL,
	`message` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_logs_device_id_created_at_idx` ON `device_logs` (`device_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`orientation` text DEFAULT 'portrait' NOT NULL,
	`resolution_width` integer DEFAULT 1080 NOT NULL,
	`resolution_height` integer DEFAULT 1920 NOT NULL,
	`volume` integer DEFAULT 0 NOT NULL,
	`test_play_requested_at` integer,
	`last_seen_at` integer,
	`agent_version` text,
	`bundle_id` text,
	`applied_version` text,
	`pending_version` text,
	`mode` text,
	`display_healthy` integer,
	`next_video_at` integer,
	`last_video_finished_at` integer,
	`time_synced` integer,
	`disk_free_bytes` integer,
	`cpu_temp_c` real,
	`mem_available_bytes` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `display_bundles` (
	`id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`r2_key` text NOT NULL,
	`schema_version` integer NOT NULL,
	`published_at` integer NOT NULL,
	`is_current` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `display_bundles_r2_key_unique` ON `display_bundles` (`r2_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `display_bundles_current_idx` ON `display_bundles` (`is_current`) WHERE "display_bundles"."is_current" = 1;--> statement-breakpoint
CREATE TABLE `display_schedules` (
	`weekday` integer PRIMARY KEY NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	CONSTRAINT "display_schedules_weekday_check" CHECK("display_schedules"."weekday" BETWEEN 0 AND 6)
);
--> statement-breakpoint
CREATE TABLE `event_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`position` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`location` text,
	`start_at` integer NOT NULL,
	`end_at` integer,
	`image_media_id` text,
	`qr_url` text,
	`category_id` text,
	`emoji` text,
	`host_name` text,
	`catch_copy` text,
	`participation` text DEFAULT 'free' NOT NULL,
	`capacity` integer,
	`participant_count` integer,
	`status` text DEFAULT 'published' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`image_media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `event_categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_status_start_at_idx` ON `events` (`status`,`start_at`);--> statement-breakpoint
CREATE TABLE `house_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`icon` text NOT NULL,
	`text` text NOT NULL,
	`position` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `house_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`house_name` text NOT NULL,
	`logo_media_id` text,
	`header_copy` text,
	`footer_copy` text,
	`footer_image_media_id` text,
	`weather_location_name` text,
	`weather_latitude` real,
	`weather_longitude` real,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`logo_media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`footer_image_media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`r2_key` text NOT NULL,
	`thumbnail_r2_key` text,
	`mime_type` text,
	`width` integer,
	`height` integer,
	`duration_seconds` real,
	`file_size` integer,
	`sha256` text,
	`codec_info` text,
	`playable` integer DEFAULT false NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`delete_after` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_r2_key_unique` ON `media` (`r2_key`);--> statement-breakpoint
CREATE INDEX `media_state_delete_after_idx` ON `media` (`state`,`delete_after`);--> statement-breakpoint
CREATE TABLE `media_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`media_id` text,
	`bundle_id` text,
	`reason` text NOT NULL,
	`quarantined` integer DEFAULT false NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`last_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bundle_id`) REFERENCES `display_bundles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "media_failures_target_check" CHECK(("media_failures"."media_id" IS NULL) <> ("media_failures"."bundle_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_failures_device_media_reason_idx` ON `media_failures` (`device_id`,`media_id`,`reason`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_failures_device_bundle_reason_idx` ON `media_failures` (`device_id`,`bundle_id`,`reason`);--> statement-breakpoint
CREATE TABLE `notices` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`image_media_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`display_mode` text DEFAULT 'always' NOT NULL,
	`display_start_time` text,
	`display_end_time` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`image_media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `playlist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`playlist_id` text NOT NULL,
	`media_id` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `playlist_items_playlist_id_position_idx` ON `playlist_items` (`playlist_id`,`position`);--> statement-breakpoint
CREATE TABLE `playlists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`r2_key` text NOT NULL,
	`r2_upload_id` text NOT NULL,
	`declared_size` integer NOT NULL,
	`state` text DEFAULT 'uploading' NOT NULL,
	`media_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_r2_key_unique` ON `uploads` (`r2_key`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`password_hash` text,
	`role` text DEFAULT 'staff' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`session_version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `video_playback_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`playlist_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`interval_minutes` integer DEFAULT 10 NOT NULL,
	`playback_mode` text DEFAULT 'sequence' NOT NULL,
	`fullscreen` integer DEFAULT true NOT NULL,
	`fade_duration_ms` integer DEFAULT 500 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_playback_settings_device_id_unique` ON `video_playback_settings` (`device_id`);--> statement-breakpoint
CREATE TABLE `weather_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`location_name` text NOT NULL,
	`temperature_c` real NOT NULL,
	`condition` text NOT NULL,
	`fetched_at` integer NOT NULL
);
