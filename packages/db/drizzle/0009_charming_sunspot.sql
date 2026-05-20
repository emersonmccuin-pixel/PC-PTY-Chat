CREATE TABLE `failed_run_dismissals` (
	`run_id` text PRIMARY KEY NOT NULL,
	`dismissed_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
