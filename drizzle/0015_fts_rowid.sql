-- FTS 维护改为按 rowid 定位。
-- 触发器原本执行 `DELETE FROM memos_fts WHERE id = old.id`，而 `id` 是
-- UNINDEXED 列，FTS5 只能全表扫描整个站点的索引副本：单条 memo 的正文/可见性/
-- 软删除变更都要付出与全站规模成正比的代价。
--
-- memos.rowid 不能直接用作 FTS 的 rowid：memos 的主键是 TEXT，VACUUM 可能重排
-- 这类表的 rowid，映射会在维护操作后错位。这里用一张显式映射表，
-- doc_id 是 INTEGER PRIMARY KEY（rowid 别名），VACUUM 保证其稳定。
CREATE TABLE `memos_fts_docs` (
	`doc_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`memo_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memos_fts_docs_memo_idx` ON `memos_fts_docs` (`memo_id`);
--> statement-breakpoint
INSERT INTO `memos_fts_docs` (`memo_id`) SELECT `id` FROM `memos`;
--> statement-breakpoint
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
INSERT INTO `memos_fts` (`rowid`, `id`, `user_id`, `visibility`, `deleted`, `content`)
SELECT `d`.`doc_id`, `m`.`id`, `m`.`user_id`, `m`.`visibility`,
	CASE WHEN `m`.`deleted_at` IS NULL THEN 0 ELSE 1 END, `m`.`content`
FROM `memos` `m` JOIN `memos_fts_docs` `d` ON `d`.`memo_id` = `m`.`id`;
--> statement-breakpoint
CREATE TRIGGER `memos_fts_insert` AFTER INSERT ON `memos` BEGIN
	INSERT INTO `memos_fts_docs` (`memo_id`) VALUES (new.`id`)
	ON CONFLICT(`memo_id`) DO NOTHING;
	INSERT INTO `memos_fts` (`rowid`, `id`, `user_id`, `visibility`, `deleted`, `content`)
	VALUES (
		(SELECT `doc_id` FROM `memos_fts_docs` WHERE `memo_id` = new.`id`),
		new.`id`,
		new.`user_id`,
		new.`visibility`,
		CASE WHEN new.`deleted_at` IS NULL THEN 0 ELSE 1 END,
		new.`content`
	);
END;
--> statement-breakpoint
CREATE TRIGGER `memos_fts_update` AFTER UPDATE OF `content`, `user_id`, `visibility`, `deleted_at` ON `memos` BEGIN
	DELETE FROM `memos_fts`
	WHERE `rowid` = (SELECT `doc_id` FROM `memos_fts_docs` WHERE `memo_id` = old.`id`);
	INSERT INTO `memos_fts` (`rowid`, `id`, `user_id`, `visibility`, `deleted`, `content`)
	VALUES (
		(SELECT `doc_id` FROM `memos_fts_docs` WHERE `memo_id` = new.`id`),
		new.`id`,
		new.`user_id`,
		new.`visibility`,
		CASE WHEN new.`deleted_at` IS NULL THEN 0 ELSE 1 END,
		new.`content`
	);
END;
--> statement-breakpoint
CREATE TRIGGER `memos_fts_delete` AFTER DELETE ON `memos` BEGIN
	DELETE FROM `memos_fts`
	WHERE `rowid` = (SELECT `doc_id` FROM `memos_fts_docs` WHERE `memo_id` = old.`id`);
	DELETE FROM `memos_fts_docs` WHERE `memo_id` = old.`id`;
END;
