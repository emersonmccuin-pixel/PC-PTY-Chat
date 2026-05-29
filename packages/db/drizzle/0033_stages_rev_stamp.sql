-- UI Spine step 3 — monotonic rev stamp for the project stages set.
--
-- stages_rev is a project-level counter incremented every time the stages
-- array is updated (PATCH /api/projects/:id/stages). The new value is
-- stamped onto each Stage object's `rev` field in the JSON blob before
-- saving, so the frontend store can use per-stage version checks to discard
-- out-of-order or duplicate WS deliveries.
--
-- DEFAULT 0 — existing projects start at 0; first stages write bumps to 1.

ALTER TABLE `projects` ADD COLUMN `stages_rev` integer NOT NULL DEFAULT 0;
