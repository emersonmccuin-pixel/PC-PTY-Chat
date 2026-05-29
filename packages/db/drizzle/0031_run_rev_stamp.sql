-- Section 36 (UI Spine step 2) — monotonic rev stamps for run rows.
--
-- Mirrors the `version` integer on work_items: incremented inside every
-- mutating write so the announcing write-door can stamp each WS delta with
-- a strictly-monotonic version. The frontend discards any incoming delta
-- whose rev ≤ the stored rev, making out-of-order / duplicate WS delivery
-- harmless.
--
-- DEFAULT 0 — existing rows start at 0; first write bumps them to 1.

ALTER TABLE `workflow_runs_v2` ADD COLUMN `rev` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD COLUMN `rev` integer NOT NULL DEFAULT 0;
