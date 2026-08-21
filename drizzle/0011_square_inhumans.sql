CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);--> statement-breakpoint
CREATE TABLE `rate_limit_buckets` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`reset_at` integer NOT NULL
);
--> statement-breakpoint
DROP INDEX `memo_comments_user_idx`;--> statement-breakpoint
CREATE INDEX `memo_comments_user_created_idx` ON `memo_comments` (`user_id`,`created_at`,`id`);--> statement-breakpoint
DROP INDEX `memo_favorites_user_idx`;--> statement-breakpoint
CREATE INDEX `memo_favorites_user_created_idx` ON `memo_favorites` (`user_id`,`created_at`,`memo_id`);--> statement-breakpoint
DROP INDEX `memo_likes_user_idx`;--> statement-breakpoint
CREATE INDEX `memo_likes_user_created_idx` ON `memo_likes` (`user_id`,`created_at`,`memo_id`);--> statement-breakpoint
DROP INDEX `memo_reposts_user_created_idx`;--> statement-breakpoint
CREATE INDEX `memo_reposts_user_created_idx` ON `memo_reposts` (`user_id`,`created_at`,`memo_id`);--> statement-breakpoint
ALTER TABLE `verification` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `verification_expires_idx` ON `verification` (`expires_at`);--> statement-breakpoint
CREATE INDEX `memos_user_active_timeline_idx` ON `memos` (`user_id`,`archived`,`deleted_at`,`pinned`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `memos_user_deleted_idx` ON `memos` (`user_id`,`deleted_at`,`id`);--> statement-breakpoint
CREATE INDEX `notifications_user_id_idx` ON `notifications` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `session_expires_idx` ON `session` (`expires_at`);