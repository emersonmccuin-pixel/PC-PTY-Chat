-- UI Spine step 3 — monotonic rev stamp for agents (pods).
--
-- Mirrors the rev stamp added to workflow_runs_v2 + agent_runs in 0031.
-- Incremented inside every mutating write on the agents table so the
-- announcing pod write-door can stamp each WS delta with a strictly-
-- monotonic version. The frontend discards any incoming delta whose
-- rev ≤ the stored rev, making out-of-order / duplicate WS delivery harmless.
--
-- DEFAULT 0 — existing rows start at 0; first write bumps them to 1.

ALTER TABLE `agents` ADD COLUMN `rev` integer NOT NULL DEFAULT 0;
