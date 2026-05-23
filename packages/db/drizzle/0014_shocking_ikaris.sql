CREATE TABLE `agent_delivery_audit_v2` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_id` text NOT NULL,
	`driver` text NOT NULL,
	`delivered_at` integer NOT NULL,
	`latency_ms` integer NOT NULL,
	FOREIGN KEY (`inbox_id`) REFERENCES `agent_inbox_v2`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_delivery_audit_v2_inbox_idx` ON `agent_delivery_audit_v2` (`inbox_id`);--> statement-breakpoint
CREATE TABLE `agent_inbox_v2` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`pc_session_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`driver` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_inbox_v2_project_session_status_idx` ON `agent_inbox_v2` (`project_id`,`pc_session_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_inbox_v2_session_created_idx` ON `agent_inbox_v2` (`pc_session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_runs_v2` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`dispatcher_session_id` text NOT NULL,
	`cc_session_id` text NOT NULL,
	`pod_name` text NOT NULL,
	`pod_revision_at_dispatch` text,
	`pod_revision_at_resume` text,
	`status` text NOT NULL,
	`continues` text,
	`parent_invoke_depth` integer DEFAULT 0 NOT NULL,
	`parent_work_item_id` text,
	`input` text,
	`result` text,
	`failure_cause` text,
	`failure_reason` text,
	`queued_at` integer NOT NULL,
	`spawned_at` integer,
	`ready_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_runs_v2_session_queued_idx` ON `agent_runs_v2` (`dispatcher_session_id`,`queued_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_v2_continues_idx` ON `agent_runs_v2` (`continues`);--> statement-breakpoint
CREATE INDEX `agent_runs_v2_project_status_idx` ON `agent_runs_v2` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_runs_v2_cc_session_idx` ON `agent_runs_v2` (`cc_session_id`);--> statement-breakpoint
CREATE TABLE `pending_asks_v2` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_run_id` text NOT NULL,
	`cc_session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`parent_work_item_id` text,
	`kind` text NOT NULL,
	`prompt_body` text NOT NULL,
	`context` text,
	`options` text,
	`status` text DEFAULT 'open' NOT NULL,
	`answer_body` text,
	`answered_by` text,
	`created_at` integer NOT NULL,
	`answered_at` integer,
	`cancelled_at` integer,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs_v2`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pending_asks_v2_project_status_idx` ON `pending_asks_v2` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `pending_asks_v2_agent_run_idx` ON `pending_asks_v2` (`agent_run_id`);--> statement-breakpoint
CREATE INDEX `pending_asks_v2_cc_session_idx` ON `pending_asks_v2` (`cc_session_id`);