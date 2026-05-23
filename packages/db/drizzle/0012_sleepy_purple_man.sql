CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`dispatcher_session_id` text NOT NULL,
	`session_id` text NOT NULL,
	`input` text NOT NULL,
	`parent_work_item_id` text,
	`parent_invoke_depth` integer NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`failure_reason` text,
	`failure_cause` text,
	`continues` text,
	`dispatched_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_runs_session_dispatched_idx` ON `agent_runs` (`dispatcher_session_id`,`dispatched_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_continues_idx` ON `agent_runs` (`continues`);--> statement-breakpoint
CREATE INDEX `agent_runs_project_idx` ON `agent_runs` (`project_id`);