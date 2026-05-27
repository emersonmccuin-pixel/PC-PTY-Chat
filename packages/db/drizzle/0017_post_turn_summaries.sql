-- Section 31.12 — post-turn summary log.
--
-- CC writes a `system:post_turn_summary` row after each assistant turn
-- carrying rich metadata (title, description, needs_action, artifact_urls).
-- The buildout deferred placing this in the UI until a week of real data
-- can inform the call (per "TBD" in the JSONL signal catalog).
-- Land the table now so the data accumulates; surface design comes later.

CREATE TABLE `post_turn_summaries` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `session_id` text,
  `summarizes_uuid` text,
  `status_category` text,
  `status_detail` text,
  `is_noteworthy` integer DEFAULT 0 NOT NULL,
  `title` text,
  `description` text,
  `recent_action` text,
  `needs_action` integer DEFAULT 0 NOT NULL,
  `artifact_urls` text,
  `timestamp` text,
  `created_at` integer NOT NULL,
  `raw` text NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `post_turn_summaries_project_idx` ON `post_turn_summaries` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `post_turn_summaries_session_idx` ON `post_turn_summaries` (`session_id`,`timestamp`);
