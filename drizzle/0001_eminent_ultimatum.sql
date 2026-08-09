CREATE TABLE `memo_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`memo_id` text NOT NULL,
	`user_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`memo_id`) REFERENCES `memos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memo_comments_memo_created_idx` ON `memo_comments` (`memo_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `memo_comments_user_idx` ON `memo_comments` (`user_id`);--> statement-breakpoint
CREATE TABLE `memo_favorites` (
	`memo_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`memo_id`, `user_id`),
	FOREIGN KEY (`memo_id`) REFERENCES `memos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memo_favorites_memo_idx` ON `memo_favorites` (`memo_id`);--> statement-breakpoint
CREATE INDEX `memo_favorites_user_idx` ON `memo_favorites` (`user_id`);--> statement-breakpoint
CREATE TABLE `memo_likes` (
	`memo_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`memo_id`, `user_id`),
	FOREIGN KEY (`memo_id`) REFERENCES `memos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memo_likes_memo_idx` ON `memo_likes` (`memo_id`);--> statement-breakpoint
CREATE INDEX `memo_likes_user_idx` ON `memo_likes` (`user_id`);--> statement-breakpoint
CREATE TABLE `memo_reposts` (
	`memo_id` text NOT NULL,
	`user_id` text NOT NULL,
	`content` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`memo_id`, `user_id`),
	FOREIGN KEY (`memo_id`) REFERENCES `memos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memo_reposts_memo_idx` ON `memo_reposts` (`memo_id`);--> statement-breakpoint
CREATE INDEX `memo_reposts_user_created_idx` ON `memo_reposts` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text DEFAULT 'Passkey' NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkey_user_idx` ON `passkey` (`user_id`);--> statement-breakpoint
ALTER TABLE `memos` ADD `visibility` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE INDEX `memos_user_visibility_created_idx` ON `memos` (`user_id`,`visibility`,`created_at`);--> statement-breakpoint
ALTER TABLE `user` ADD `username` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `display_username` text;--> statement-breakpoint
ALTER TABLE `user` ADD `bio` text;--> statement-breakpoint
-- 存量用户回填唯一用户名（迁移脚本手工补充，避免唯一索引冲突）
UPDATE `user` SET `username` = 'u' || substr(replace(lower(id), '-', ''), 1, 24) WHERE `username` = '' OR `username` IS NULL;--> statement-breakpoint
UPDATE `user` SET `display_username` = `username` WHERE `display_username` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique_idx` ON `user` (`username`);
