CREATE TABLE `memo_links` (
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`source_id`, `target_id`),
	FOREIGN KEY (`source_id`) REFERENCES `memos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `memos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memo_links_target_idx` ON `memo_links` (`target_id`);--> statement-breakpoint
CREATE TABLE `memo_review_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`memo_id` text NOT NULL,
	`reviewed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`memo_id`) REFERENCES `memos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memo_review_events_user_reviewed_idx` ON `memo_review_events` (`user_id`,`reviewed_at`);--> statement-breakpoint
CREATE INDEX `memo_review_events_memo_reviewed_idx` ON `memo_review_events` (`memo_id`,`reviewed_at`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `memos_fts` USING fts5(
	`id` UNINDEXED,
	`content`,
	tokenize='trigram'
);
--> statement-breakpoint
INSERT INTO `memos_fts` (`id`, `content`) SELECT `id`, `content` FROM `memos`;
--> statement-breakpoint
CREATE TRIGGER `memos_fts_insert` AFTER INSERT ON `memos` BEGIN
	INSERT INTO `memos_fts` (`id`, `content`) VALUES (new.`id`, new.`content`);
END;
--> statement-breakpoint
CREATE TRIGGER `memos_fts_update` AFTER UPDATE OF `content` ON `memos` BEGIN
	DELETE FROM `memos_fts` WHERE `id` = old.`id`;
	INSERT INTO `memos_fts` (`id`, `content`) VALUES (new.`id`, new.`content`);
END;
--> statement-breakpoint
CREATE TRIGGER `memos_fts_delete` AFTER DELETE ON `memos` BEGIN
	DELETE FROM `memos_fts` WHERE `id` = old.`id`;
END;
