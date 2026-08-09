CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`memo_id` text NOT NULL,
	`type` text NOT NULL,
	`reference_id` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`memo_id`) REFERENCES `memos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_event_unique_idx` ON `notifications` (`type`,`actor_id`,`memo_id`,`reference_id`);--> statement-breakpoint
CREATE INDEX `notifications_user_created_idx` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_user_read_idx` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
ALTER TABLE `memos` ADD `client_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `memos_user_client_unique_idx` ON `memos` (`user_id`,`client_id`) WHERE "memos"."client_id" IS NOT NULL;