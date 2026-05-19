ALTER TABLE `projects` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill positions in (created_at, id) order so the existing rail order
-- is preserved post-migration. Position 0 = oldest = top of rail today.
UPDATE `projects` SET `position` = (
  SELECT COUNT(*) FROM `projects` AS p2
  WHERE p2.created_at < `projects`.created_at
     OR (p2.created_at = `projects`.created_at AND p2.id < `projects`.id)
);--> statement-breakpoint
CREATE INDEX `projects_position_idx` ON `projects` (`position`);