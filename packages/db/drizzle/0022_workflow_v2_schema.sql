-- Section 19.3 — Workflow rebuild from Archon: v2 schema.
--
-- Adds the work-item `is_workflow_root` flag + two v2 tables that coexist with
-- the legacy `workflow_runs` table (the old runtime still owns that) until the
-- 19.13 cutover renames the old one to `*_v1_archive`.
--
-- v2 model: a workflow run IS a work item (`is_workflow_root`). Each node spawns
-- a child WI; node outputs live on those children. The sidecar holds only DAG
-- bookkeeping (per-node state + reject-iteration counts) — see
-- docs/buildout/workflow-rebuild-port-map.md ("stateless over work items").
-- `workflow_run_events` is observability/audit only; resume reads the children.

ALTER TABLE work_items ADD COLUMN is_workflow_root integer DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE TABLE `workflow_runs_v2` (
  `id` text PRIMARY KEY NOT NULL,
  `workflow_id` text NOT NULL,
  `workflow_name` text NOT NULL,
  `project_id` text NOT NULL,
  `work_item_id` text,
  `trigger` text NOT NULL,
  `stage_id` text,
  `triggered_by_session_id` text,
  `status` text DEFAULT 'pending' NOT NULL,
  `workflow_yaml_snapshot` text NOT NULL,
  `worktree_path` text,
  `dag_state` text DEFAULT '{"nodes":{}}' NOT NULL,
  `trigger_context` text DEFAULT '{}' NOT NULL,
  `metadata` text DEFAULT '{}' NOT NULL,
  `last_reason` text,
  `created_at` integer NOT NULL,
  `started_at` integer,
  `ended_at` integer,
  `last_activity_at` integer,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `workflow_runs_v2_project_idx` ON `workflow_runs_v2` (`project_id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_v2_status_idx` ON `workflow_runs_v2` (`status`);--> statement-breakpoint
CREATE INDEX `workflow_runs_v2_workflow_idx` ON `workflow_runs_v2` (`workflow_id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_v2_work_item_idx` ON `workflow_runs_v2` (`work_item_id`);--> statement-breakpoint

CREATE TABLE `workflow_run_events` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL,
  `type` text NOT NULL,
  `node_id` text,
  `data` text,
  `at` integer NOT NULL,
  FOREIGN KEY (`run_id`) REFERENCES `workflow_runs_v2`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `workflow_run_events_run_idx` ON `workflow_run_events` (`run_id`);
