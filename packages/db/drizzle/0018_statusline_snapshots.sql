-- Section 31.11 — statusline snapshot log.
--
-- Every POST /api/internal/statusline-data writes one row. Many per session
-- (CC fires statusLine.command on every status-line refresh, debounced
-- ~1×/turn). Latest-per-session = end-of-session running totals; daily
-- rollup = max(`cost_usd`) per session for sessions started that day, summed.
--
-- The in-memory `latestStatuslineByProject` Map remains the source for the
-- left-rail caps panel (low-latency live update); this table is the time-
-- series log the Usage tab + future aggregations read from.

CREATE TABLE `statusline_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `pc_session_id` text NOT NULL,
  `cc_session_id` text,
  `received_at` integer NOT NULL,
  `model_id` text,
  `model_display_name` text,
  `five_hour_pct` real,
  `five_hour_resets_at` text,
  `seven_day_pct` real,
  `seven_day_resets_at` text,
  `total_cost_usd` real,
  `total_duration_ms` integer,
  `total_api_duration_ms` integer,
  `context_current_usage` integer,
  `context_window_size` integer,
  `context_used_percentage` real,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `statusline_snapshots_project_idx` ON `statusline_snapshots` (`project_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `statusline_snapshots_session_idx` ON `statusline_snapshots` (`pc_session_id`,`received_at`);
