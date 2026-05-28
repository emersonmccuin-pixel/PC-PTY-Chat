-- Remove the retired Quick Tasks product surface from live data.
--
-- Historical migrations created a `kind = 'quick-tasks'` project singleton and
-- a `tagged_project_id` helper column. Avoid a SQLite table rebuild here: flip
-- any singleton row back to a standard project, remove the special indexes,
-- and soft-delete the obsolete stock pod. The TypeScript surface no longer
-- references these columns.

UPDATE projects SET kind = 'standard' WHERE kind = 'quick-tasks';
--> statement-breakpoint
DROP INDEX IF EXISTS `projects_quick_tasks_singleton_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `work_items_tagged_project_idx`;
--> statement-breakpoint
UPDATE agents
  SET deleted_at = CAST(strftime('%s', 'now') * 1000 AS INTEGER),
      updated_at = CAST(strftime('%s', 'now') * 1000 AS INTEGER)
  WHERE name = 'quick-tasks-pm'
    AND deleted_at IS NULL;
