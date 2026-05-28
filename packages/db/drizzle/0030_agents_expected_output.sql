-- Section 26 Issue #3 — add expected_output column to agents table.
--
-- Enables custom pods (coder, qa-tester, etc.) to declare a default
-- expected_output that createAgentWorkItem consults before falling back to
-- the stock map in pod-defaults.ts. Nullable — stock pods keep using the
-- hardcoded map (no backfill needed); user-created pods set it via the
-- agent-designer or future UI.

ALTER TABLE `agents` ADD COLUMN `expected_output` text;
