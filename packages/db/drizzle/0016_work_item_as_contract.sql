-- Section 26 — work-item-as-contract v1.
--
-- Adds the contract fields to `work_items`. Every agent dispatch creates a
-- work item with `is_agent_task = 1`, an `expected_output` spec, a derived
-- `acceptance_criteria` predicate set, and a `verification_tier`. See
-- the agent output contract.
--
-- `is_workflow_root` is deliberately deferred to Section 19 (workflow
-- rebuild) — the workflow-side schema lands there together.

ALTER TABLE work_items ADD COLUMN is_agent_task integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE work_items ADD COLUMN ephemeral integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE work_items ADD COLUMN acceptance_criteria text;--> statement-breakpoint
ALTER TABLE work_items ADD COLUMN expected_output text;--> statement-breakpoint
ALTER TABLE work_items ADD COLUMN verification_tier text;--> statement-breakpoint
ALTER TABLE work_items ADD COLUMN verification_status text;--> statement-breakpoint
ALTER TABLE work_items ADD COLUMN verification_notes text;--> statement-breakpoint
ALTER TABLE work_items ADD COLUMN assigned_agent_run_id text;--> statement-breakpoint
ALTER TABLE work_items ADD COLUMN worktree_path text;--> statement-breakpoint

CREATE INDEX `work_items_agent_task_idx` ON `work_items` (`project_id`,`is_agent_task`);
