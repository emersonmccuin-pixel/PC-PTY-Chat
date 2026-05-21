CREATE TABLE `agent_delivery_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_id` text NOT NULL,
	`channel_push_attempted_at` integer,
	`channel_push_succeeded` integer,
	`hook_drained_at` integer,
	`driver` text DEFAULT 'unknown' NOT NULL,
	FOREIGN KEY (`inbox_id`) REFERENCES `agent_inbox`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_delivery_audit_inbox_idx` ON `agent_delivery_audit` (`inbox_id`);--> statement-breakpoint
CREATE TABLE `agent_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`recipient_session_id` text NOT NULL,
	`event_kind` text NOT NULL,
	`payload_body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_inbox_project_session_status_idx` ON `agent_inbox` (`project_id`,`recipient_session_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_inbox_session_created_idx` ON `agent_inbox` (`recipient_session_id`,`created_at`);