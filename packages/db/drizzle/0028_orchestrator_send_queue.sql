-- Durable per-session orchestrator send queue.
--
-- Prompts submitted while Claude is busy or still spawning are accepted into
-- this table and drained FIFO when the PTY returns to ready. The queue belongs
-- to the PC orchestrator session row, not the transient claude.exe process.

CREATE TABLE `orchestrator_send_queue` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `session_id` text NOT NULL,
  `client_message_id` text NOT NULL,
  `text` text NOT NULL,
  `status` text NOT NULL,
  `delivery_attempts` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `delivered_at` integer,
  `failed_at` integer,
  `cancelled_at` integer,
  `failure_reason` text,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`session_id`) REFERENCES `orchestrator_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint

CREATE UNIQUE INDEX `orch_send_queue_client_msg_idx`
  ON `orchestrator_send_queue` (`session_id`, `client_message_id`);
--> statement-breakpoint

CREATE INDEX `orch_send_queue_project_idx`
  ON `orchestrator_send_queue` (`project_id`, `created_at`);
--> statement-breakpoint

CREATE INDEX `orch_send_queue_session_status_idx`
  ON `orchestrator_send_queue` (`session_id`, `status`, `created_at`);
