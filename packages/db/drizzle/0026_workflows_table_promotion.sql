-- Section 19.16 — workflows table promotion.
--
-- Before this migration the `workflows` table existed only as scaffolding
-- (created in 0000_init, never written to — see the header comment on the
-- table in schema.ts). Workflows lived as YAML files on disk under each
-- project's `.project-companion/workflows/`. Section 19's 2-boot import plan
-- (19.13) moves them into the DB.
--
-- Shape changes:
--   * Add `scope` ('global' | 'project'), default 'project'.
--   * Make `project_id` nullable (NULL when scope='global').
--   * Add `display_name`, `description`, `disabled`, `origin` (`'user-created'`
--     only in v1 — no stock workflows; column kept for forward compat with
--     the agents pattern).
--   * Drop `source_filename` — irrelevant once the DB row is canonical.
--   * Replace `workflows_project_idx` with `workflows_scope_project_idx` plus
--     two partial UNIQUE indices for live globals + per-project rows
--     (mirrors `agents_global_name_idx` + `agents_project_name_idx`).
--
-- SQLite can't ALTER a column from NOT NULL to NULL in place. Since the table
-- has no rows in the wild, we drop + recreate from scratch. This matches the
-- pattern 0025 used for `failed_run_dismissals` when it needed to repoint a FK.
--
-- New `workflow_audit` table mirrors `agent_audit`. Every mutation in
-- packages/db/src/repos/workflows.ts writes an audit row in the SAME tx as
-- the mutation. Surfaces the History tab when the workflows page picks it up.

DROP INDEX IF EXISTS `workflows_project_idx`;--> statement-breakpoint
DROP TABLE IF EXISTS `workflows`;--> statement-breakpoint

CREATE TABLE `workflows` (
  `id` text PRIMARY KEY NOT NULL,
  `scope` text DEFAULT 'project' NOT NULL,
  `project_id` text,
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
