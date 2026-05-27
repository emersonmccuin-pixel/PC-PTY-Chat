-- Section 35 — Human-readable work-item callsigns.
--
-- Adds a display-alias short code to work items: `<project-slug>-N` for top-
-- level rows (e.g. `pc-2`), `<parent.callsign>.M` for children (`pc-2.1`).
-- ULIDs stay canonical everywhere internal (FKs, typed-refs catalog, WS
-- envelopes, tests, events.jsonl); callsign is a SECOND identifier surfaced
-- alongside.
--
-- Locks (full list in the work-item callsign contract):
-- - alias, not replacement;
-- - unpadded, monotonic, never-reused root sequence on projects.callsign_seq;
-- - per-parent child sequence computed from MAX(suffix)+1 over existing
--   children at insert time;
-- - agent contracts (is_agent_task=1) stay NULL — they don't burn user-
--   visible numbers;
-- - re-parenting is stable (write-once);
-- - in-migration backfill, ordered by created_at per project;
-- - non-agent child of an agent-contract parent gets a TOP-LEVEL number
--   (fallback — its nearest non-agent ancestor doesn't exist).

ALTER TABLE `projects` ADD COLUMN `callsign_seq` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `work_items` ADD COLUMN `callsign` text;--> statement-breakpoint
CREATE UNIQUE INDEX `work_items_callsign_idx` ON `work_items` (`project_id`, `callsign`) WHERE `callsign` IS NOT NULL;--> statement-breakpoint

-- Backfill in three stages:
--
--   1. `effective_roots` — non-agent rows whose nearest non-agent ancestor
--      doesn't exist. That's parent_id IS NULL OR parent is an agent
--      contract OR parent row doesn't exist (dangling). Numbered per-project
--      in created_at order (id as tie-breaker).
--   2. Recurse: walk non-agent children of non-agent parents, appending
--      `.M` where M is the row's rank among non-agent siblings under the
--      same parent in created_at order.
--   3. Bump projects.callsign_seq to the count of effective roots so future
--      top-level inserts pick up at the right number.

WITH RECURSIVE
  effective_roots AS (
    SELECT
      wi.id,
      wi.project_id,
      p.slug AS project_slug,
      ROW_NUMBER() OVER (
        PARTITION BY wi.project_id
        ORDER BY wi.created_at, wi.id
      ) AS rn
    FROM work_items wi
    JOIN projects p ON p.id = wi.project_id
    WHERE wi.is_agent_task = 0
      AND (
        wi.parent_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM work_items parent
          WHERE parent.id = wi.parent_id
            AND parent.is_agent_task = 0
        )
      )
  ),
  tree AS (
    SELECT
      r.id,
      r.project_id,
      r.project_slug || '-' || CAST(r.rn AS TEXT) AS callsign
    FROM effective_roots r
    UNION ALL
    SELECT
      c.id,
      c.project_id,
      t.callsign || '.' || CAST(
        (SELECT COUNT(*)
           FROM work_items s
          WHERE s.parent_id = c.parent_id
            AND s.is_agent_task = 0
            AND (s.created_at < c.created_at
                 OR (s.created_at = c.created_at AND s.id <= c.id))) AS TEXT
      ) AS callsign
    FROM work_items c
    JOIN tree t ON t.id = c.parent_id
    WHERE c.is_agent_task = 0
  )
UPDATE work_items
SET callsign = (SELECT t.callsign FROM tree t WHERE t.id = work_items.id)
WHERE id IN (SELECT id FROM tree);--> statement-breakpoint

UPDATE projects
SET callsign_seq = (
  SELECT COUNT(*)
    FROM work_items wi
   WHERE wi.project_id = projects.id
     AND wi.is_agent_task = 0
     AND (
       wi.parent_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM work_items parent
         WHERE parent.id = wi.parent_id
           AND parent.is_agent_task = 0
       )
     )
);
