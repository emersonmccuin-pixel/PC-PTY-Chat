CREATE TABLE `pending_asks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text,
	`parent_work_item_id` text,
	`kind` text NOT NULL,
	`question` text NOT NULL,
	`context` text,
	`options` text,
	`status` text DEFAULT 'waiting' NOT NULL,
	`answer` text,
	`answered_by` text,
	`created_at` integer NOT NULL,
	`answered_at` integer,
	`cancelled_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pending_asks_project_status_idx` ON `pending_asks` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `pending_asks_session_idx` ON `pending_asks` (`session_id`);--> statement-breakpoint
CREATE INDEX `pending_asks_work_item_idx` ON `pending_asks` (`parent_work_item_id`);