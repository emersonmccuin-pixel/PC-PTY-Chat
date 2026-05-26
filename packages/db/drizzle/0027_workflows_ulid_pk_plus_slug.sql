-- Section 19.16 follow-up — promote `workflows.id` to ULID + add `slug` column.
--
-- 0026 set the workflows PK to the YAML slug. That makes cross-project slug
-- reuse impossible: two projects both authoring `triage.yaml` would collide
-- on insert. The agents pattern dodges this by using ULID for the PK and
-- carrying the user-visible name as a separate column with per-scope partial
-- UNIQUE — adopted here for parity.
--
-- The table is still empty in the wild (only test tmp DBs have applied 0026
-- before this migration runs), so drop + recreate is safe.

DROP INDEX IF EXISTS `workflows_scope_project_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `workflows_global_name_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `workflows_project_name_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `workflow_audit_workflow_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `workflow_audit_change_set_idx`;--> statement-breakpoint
DROP TABLE IF EXISTS `workflow_audit`;--> statement-breakpoint
DROP TABLE IF EXISTS `workflows`;--> statement-breakpoint

CREATE TABLE `workflows` (
  `id` text PRIMARY KEY NOT NULL,
  `scope` text DEFAULT 'project' NOT NULL,
  `project_id` text,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `display_name` text,
  `description` text,
  `yaml` text NOT NULL,
  `yaml_hash` text NOT NULL,
  `parsed_definition` text,
  `status` text DEFAULT 'active' NOT NULL,
  `parse_error` text,
  `disabled` integer DEFAULT 0 NOT NULL,
  `origin` text DEFAULT 'user-created' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint

CREATE INDEX `workflows_scope_project_idx` ON `workflows` (`scope`, `project_id`);--> statement-breakpoint

CREATE UNIQUE INDEX `workflows_global_slug_idx` ON `workflows` (`slug`)
  WHERE scope = 'global' AND deleted_at IS NULL;--> statement-breakpoint

CREATE UNIQUE INDEX `workflows_project_slug_idx` ON `workflows` (`project_id`, `slug`)
  WHERE scope = 'project' AND deleted_at IS NULL;--> statement-breakpoint

CREATE UNIQUE INDEX `workflows_global_name_idx` ON `workflows` (`name`)
  WHERE scope = 'global' AND deleted_at IS NULL;--> statement-breakpoint

CREATE UNIQUE INDEX `workflows_project_name_idx` ON `workflows` (`project_id`, `name`)
  WHERE scope = 'project' AND deleted_at IS NULL;--> statement-breakpoint

CREATE TABLE `workflow_audit` (
  `id` text PRIMARY KEY NOT NULL,
  `workflow_id` text NOT NULL,
  `change_set_id` text,
  `actor` text NOT NULL,
  `field` text NOT NULL,
  `field_ref` text,
  `prior_value` text,
  `new_value` text,
  `reason` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint

CREATE INDEX `workflow_audit_workflow_idx` ON `workflow_audit` (`workflow_id`);--> statement-breakpoint
CREATE INDEX `workflow_audit_change_set_idx` ON `workflow_audit` (`change_set_id`);
