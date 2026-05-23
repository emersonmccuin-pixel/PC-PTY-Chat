CREATE TABLE `instruction_deposits` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`project_id` text NOT NULL,
	`dispatcher_session_id` text NOT NULL,
	`instruction` text NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`deposited_at` integer NOT NULL,
	`consumed_at` integer,
	`cancelled_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instruction_deposits_run_waiting_idx` ON `instruction_deposits` (`run_id`) WHERE status = 'waiting';--> statement-breakpoint
CREATE INDEX `instruction_deposits_status_idx` ON `instruction_deposits` (`status`);