-- Section 34.1 — Quick Tasks (pinned cross-project task surface).
--
-- `kind` differentiates the system-seeded Quick Tasks "special project" from
-- user-created ones. Default 'standard' keeps existing rows untouched. Partial
-- unique index guarantees at most one live `quick-tasks` row per installation;
-- boot-time `ensureQuickTasksProject` inserts it if missing.
--
-- `tagged_project_id` on work_items is a soft pointer letting a quick task
-- carry a hint about which project it belongs to ("ping Pat about Q3 budget"
-- tagged to HR Ops). Nullable; no FK cascade — we soft-delete projects, the
-- tag stays as a forensic crumb. App-level: lookups treat dangling tags as
-- untagged.

ALTER TABLE `projects` ADD COLUMN `kind` text NOT NULL DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `tagged_project_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_quick_tasks_singleton_idx` ON `projects` (`kind`) WHERE `kind` = 'quick-tasks' AND `deleted_at` IS NULL;--> statement-breakpoint
CREATE INDEX `work_items_tagged_project_idx` ON `work_items` (`tagged_project_id`) WHERE `tagged_project_id` IS NOT NULL;
