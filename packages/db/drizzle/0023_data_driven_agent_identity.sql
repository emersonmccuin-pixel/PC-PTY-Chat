-- Section 36 — Data-driven agent identity.
--
-- Adds two columns to the `agents` table:
--   * `origin` — `'stock' | 'user-created'`. Replaces the multi-list "is this
--     pod stock?" pattern (STOCK_POD_NAMES + the web mirror + the seed-time
--     drift assertion). Route-layer protection reads this column going forward.
--   * `dispatch_guidance` — orchestrator-facing "when to dispatch this agent"
--     hint, rendered into the orchestrator's `{{AVAILABLE_AGENTS}}` variable
--     by the pod materializer.
--
-- Backfill: the current stock-pod roster is captured INLINE (not via the
-- @pc/domain constant, which Section 36 deletes in a later phase). The 10
-- names below are the canonical stock list at 2026-05-25 — `orchestrator`,
-- `researcher`, `writer`, `code-writer`, `reviewer`, `planner`, `extractor`,
-- `agent-designer`, `quick-tasks-pm`, `caisson`. Any agent row matching one
-- of those names lands as `origin='stock'`; everything else stays at the
-- column default `'user-created'`.

ALTER TABLE `agents` ADD COLUMN `origin` text DEFAULT 'user-created' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD COLUMN `dispatch_guidance` text;--> statement-breakpoint

UPDATE `agents`
SET `origin` = 'stock'
WHERE `name` IN (
  'orchestrator',
  'researcher',
  'writer',
  'code-writer',
  'reviewer',
  'planner',
  'extractor',
  'agent-designer',
  'quick-tasks-pm',
  'caisson'
);
