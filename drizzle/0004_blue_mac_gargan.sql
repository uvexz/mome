ALTER TABLE `memos` ADD `global_pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `memos` AS `current`
SET `pinned` = false
WHERE `current`.`pinned` = true
  AND EXISTS (
    SELECT 1
    FROM `memos` AS `newer`
    WHERE `newer`.`user_id` = `current`.`user_id`
      AND `newer`.`pinned` = true
      AND (
        `newer`.`updated_at` > `current`.`updated_at`
        OR (
          `newer`.`updated_at` = `current`.`updated_at`
          AND `newer`.`created_at` > `current`.`created_at`
        )
        OR (
          `newer`.`updated_at` = `current`.`updated_at`
          AND `newer`.`created_at` = `current`.`created_at`
          AND `newer`.`id` > `current`.`id`
        )
      )
  );--> statement-breakpoint
CREATE UNIQUE INDEX `memos_user_pinned_unique_idx` ON `memos` (`user_id`) WHERE "memos"."pinned" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `memos_global_pinned_unique_idx` ON `memos` (`global_pinned`) WHERE "memos"."global_pinned" = 1;