-- 重建 memos_fts：增加 user_id / visibility / deleted 列（UNINDEXED），
-- 让 FTS 内容副本自带归属、可见性与软删标记，
-- 任何直接查询 FTS 的代码都能就地过滤，避免"私密内容进全量索引副本"的纵深防御缺口。
-- 软删行仍保留在 FTS 中（回收站需要全文搜索），以 deleted 列标记。
DROP TRIGGER `memos_fts_insert`;
--> statement-breakpoint
DROP TRIGGER `memos_fts_update`;
--> statement-breakpoint
DROP TRIGGER `memos_fts_delete`;
--> statement-breakpoint
DROP TABLE `memos_fts`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `memos_fts` USING fts5(
	`id` UNINDEXED,
	`user_id` UNINDEXED,
	`visibility` UNINDEXED,
	`deleted` UNINDEXED,
	`content`,
	tokenize='trigram'
);
--> statement-breakpoint
INSERT INTO `memos_fts` (`id`, `user_id`, `visibility`, `deleted`, `content`)
SELECT `id`, `user_id`, `visibility`, CASE WHEN `deleted_at` IS NULL THEN 0 ELSE 1 END, `content` FROM `memos`;
--> statement-breakpoint
CREATE TRIGGER `memos_fts_insert` AFTER INSERT ON `memos` BEGIN
	INSERT INTO `memos_fts` (`id`, `user_id`, `visibility`, `deleted`, `content`)
	VALUES (
		new.`id`,
		new.`user_id`,
		new.`visibility`,
		CASE WHEN new.`deleted_at` IS NULL THEN 0 ELSE 1 END,
		new.`content`
	);
END;
--> statement-breakpoint
CREATE TRIGGER `memos_fts_update` AFTER UPDATE OF `content`, `user_id`, `visibility`, `deleted_at` ON `memos` BEGIN
	DELETE FROM `memos_fts` WHERE `id` = old.`id`;
	INSERT INTO `memos_fts` (`id`, `user_id`, `visibility`, `deleted`, `content`)
	VALUES (
		new.`id`,
		new.`user_id`,
		new.`visibility`,
		CASE WHEN new.`deleted_at` IS NULL THEN 0 ELSE 1 END,
		new.`content`
	);
END;
--> statement-breakpoint
CREATE TRIGGER `memos_fts_delete` AFTER DELETE ON `memos` BEGIN
	DELETE FROM `memos_fts` WHERE `id` = old.`id`;
END;
