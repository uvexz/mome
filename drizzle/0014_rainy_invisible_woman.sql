CREATE TABLE `compat_refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `compat_refresh_user_idx` ON `compat_refresh_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `compat_refresh_expires_idx` ON `compat_refresh_tokens` (`expires_at`);