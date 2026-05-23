-- Section 25 Session 11 — Phase D clean swap.
--
-- Renames v1 agent-system tables to *_v1_archive (data preserved for forensic
-- read-only access; no app code reads from them). Renames v2 tables to the
-- bare names. Drops Section 24's instruction_deposits table (D2 lock — pure
-- vestigial scaffold that was never used in production after the protocol
-- pivoted to the labs-driven v2 design).
--
-- Index renames happen alongside the table renames so the bare-name tables
-- carry indices with clean (non-`_v2`) names.

-- ---------- Drop Section 24 instruction_deposits (D2 lock) ----------
DROP INDEX IF EXISTS instruction_deposits_run_waiting_idx;--> statement-breakpoint
DROP INDEX IF EXISTS instruction_deposits_status_idx;--> statement-breakpoint
DROP TABLE instruction_deposits;--> statement-breakpoint

-- ---------- Archive v1 tables ----------
-- Drop v1 indices first; rename moves the table only.
DROP INDEX IF EXISTS agent_runs_session_dispatched_idx;--> statement-breakpoint
DROP INDEX IF EXISTS agent_runs_continues_idx;--> statement-breakpoint
DROP INDEX IF EXISTS agent_runs_project_idx;--> statement-breakpoint
ALTER TABLE agent_runs RENAME TO agent_runs_v1_archive;--> statement-breakpoint

DROP INDEX IF EXISTS pending_asks_project_status_idx;--> statement-breakpoint
DROP INDEX IF EXISTS pending_asks_session_idx;--> statement-breakpoint
DROP INDEX IF EXISTS pending_asks_work_item_idx;--> statement-breakpoint
ALTER TABLE pending_asks RENAME TO pending_asks_v1_archive;--> statement-breakpoint

DROP INDEX IF EXISTS agent_inbox_project_session_status_idx;--> statement-breakpoint
DROP INDEX IF EXISTS agent_inbox_session_created_idx;--> statement-breakpoint
ALTER TABLE agent_inbox RENAME TO agent_inbox_v1_archive;--> statement-breakpoint

DROP INDEX IF EXISTS agent_delivery_audit_inbox_idx;--> statement-breakpoint
ALTER TABLE agent_delivery_audit RENAME TO agent_delivery_audit_v1_archive;--> statement-breakpoint

-- ---------- Promote v2 tables to bare names ----------
ALTER TABLE agent_runs_v2 RENAME TO agent_runs;--> statement-breakpoint
DROP INDEX IF EXISTS agent_runs_v2_session_queued_idx;--> statement-breakpoint
DROP INDEX IF EXISTS agent_runs_v2_continues_idx;--> statement-breakpoint
DROP INDEX IF EXISTS agent_runs_v2_project_status_idx;--> statement-breakpoint
DROP INDEX IF EXISTS agent_runs_v2_cc_session_idx;--> statement-breakpoint
CREATE INDEX `agent_runs_session_queued_idx` ON `agent_runs` (`dispatcher_session_id`,`queued_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_continues_idx` ON `agent_runs` (`continues`);--> statement-breakpoint
CREATE INDEX `agent_runs_project_status_idx` ON `agent_runs` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_runs_cc_session_idx` ON `agent_runs` (`cc_session_id`);--> statement-breakpoint

ALTER TABLE pending_asks_v2 RENAME TO pending_asks;--> statement-breakpoint
DROP INDEX IF EXISTS pending_asks_v2_project_status_idx;--> statement-breakpoint
DROP INDEX IF EXISTS pending_asks_v2_agent_run_idx;--> statement-breakpoint
DROP INDEX IF EXISTS pending_asks_v2_cc_session_idx;--> statement-breakpoint
CREATE INDEX `pending_asks_project_status_idx` ON `pending_asks` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `pending_asks_agent_run_idx` ON `pending_asks` (`agent_run_id`);--> statement-breakpoint
CREATE INDEX `pending_asks_cc_session_idx` ON `pending_asks` (`cc_session_id`);--> statement-breakpoint

ALTER TABLE agent_inbox_v2 RENAME TO agent_inbox;--> statement-breakpoint
DROP INDEX IF EXISTS agent_inbox_v2_project_session_status_idx;--> statement-breakpoint
DROP INDEX IF EXISTS agent_inbox_v2_session_created_idx;--> statement-breakpoint
CREATE INDEX `agent_inbox_project_session_status_idx` ON `agent_inbox` (`project_id`,`pc_session_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_inbox_session_created_idx` ON `agent_inbox` (`pc_session_id`,`created_at`);--> statement-breakpoint

ALTER TABLE agent_delivery_audit_v2 RENAME TO agent_delivery_audit;--> statement-breakpoint
DROP INDEX IF EXISTS agent_delivery_audit_v2_inbox_idx;--> statement-breakpoint
CREATE INDEX `agent_delivery_audit_inbox_idx` ON `agent_delivery_audit` (`inbox_id`);
