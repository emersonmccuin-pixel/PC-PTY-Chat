CREATE TABLE `live_outbox` (
  `seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `id` text NOT NULL,
  `scope` text NOT NULL,
  `project_id` text,
  `type` text NOT NULL,
  `entity` text NOT NULL,
  `entity_id` text,
  `version` integer,
  `payload` text NOT NULL,
  `created_at` integer NOT NULL,
  `published_at` integer,
  CONSTRAINT `live_outbox_scope_check` CHECK (`scope` IN ('global', 'project')),
  CONSTRAINT `live_outbox_scope_project_check` CHECK (
    (`scope` = 'global' AND `project_id` IS NULL)
    OR (`scope` = 'project' AND `project_id` IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_outbox_id_idx` ON `live_outbox` (`id`);
--> statement-breakpoint
CREATE INDEX `live_outbox_created_idx` ON `live_outbox` (`created_at`);
--> statement-breakpoint
CREATE INDEX `live_outbox_project_seq_idx` ON `live_outbox` (`project_id`, `seq`);
--> statement-breakpoint
CREATE INDEX `live_outbox_scope_seq_idx` ON `live_outbox` (`scope`, `seq`);
--> statement-breakpoint
CREATE INDEX `live_outbox_type_seq_idx` ON `live_outbox` (`type`, `seq`);
--> statement-breakpoint
CREATE INDEX `live_outbox_entity_idx` ON `live_outbox` (`entity`, `entity_id`, `seq`);
