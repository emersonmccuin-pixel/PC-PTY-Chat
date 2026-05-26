-- Section 19.12 — drop the v1 workflow_runs table.
--
-- The v1 runtime (apps/server/src/services/workflow-runtime.ts) was the only
-- writer; deleted in 19.12 chunk 3b. v2 runs live in `workflow_runs_v2` plus
-- `workflow_run_events` (introduced by 0022_workflow_v2_schema).
--
-- `failed_run_dismissals.run_id` previously FK'd to `workflow_runs.id`. The
-- v2 dismiss path (apps/server/src/index.ts POST /workflow-runs/:runId/dismiss
-- after the 19.12 rewire) writes v2 run-ids into the same column. Rebuild
-- the table with the FK pointed at `workflow_runs_v2.id`.
--
-- Pre-existing v1 dismissal rows are dropped: the v1 history they pointed at
-- is going away, the row carries no other state, and per the 19 buildout the
-- user has been driving v2 since 19.x — v1 dismissals are presumed empty.

DROP TABLE IF EXISTS `failed_run_dismissals`;--> statement-breakpoint

DROP TABLE IF EXISTS `workflow_runs`;--> statement-breakpoint

CREATE TABLE `failed_run_dismissals` (
  `run_id` text PRIMARY KEY NOT NULL,
  `dismissed_at` integer NOT NULL,
  FOREIGN KEY (`run_id`) REFERENCES `workflow_runs_v2`(`id`) ON UPDATE no action ON DELETE no action
);
