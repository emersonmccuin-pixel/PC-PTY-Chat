CREATE TABLE `orchestrator_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_session_id` text,
	`model` text,
	`title` text,
	`status` text DEFAULT 'active' NOT NULL,
	`ended_reason` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orch_sessions_active_per_project_idx` ON `orchestrator_sessions` (`project_id`) WHERE status = 'active' AND deleted_at IS NULL;--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`stages` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_idx` ON `projects` (`slug`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE TABLE `settings_global` (
	`id` text PRIMARY KEY NOT NULL,
	`values` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`stage_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`status_reason` text,
	`fields` text DEFAULT '{}' NOT NULL,
	`history` text DEFAULT '[]' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `work_items_project_idx` ON `work_items` (`project_id`);--> statement-breakpoint
CREATE INDEX `work_items_stage_idx` ON `work_items` (`project_id`,`stage_id`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`workflow_name` text NOT NULL,
	`project_id` text NOT NULL,
	`work_item_id` text,
	`parent_run_id` text,
	`parent_node_id` text,
	`stage_id` text,
	`trigger` text NOT NULL,
	`triggered_by_session_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`workflow_yaml_snapshot` text NOT NULL,
	`worktree_path` text,
	`inputs` text DEFAULT '{}' NOT NULL,
	`outputs` text DEFAULT '{}' NOT NULL,
	`node_outputs` text DEFAULT '{}' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`last_reason` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`last_activity_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_project_idx` ON `workflow_runs` (`project_id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_status_idx` ON `workflow_runs` (`status`);--> statement-breakpoint
CREATE INDEX `workflow_runs_workflow_idx` ON `workflow_runs` (`workflow_id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_parent_idx` ON `workflow_runs` (`parent_run_id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_work_item_idx` ON `workflow_runs` (`work_item_id`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`yaml` text NOT NULL,
	`yaml_hash` text NOT NULL,
	`parsed_definition` text,
	`status` text DEFAULT 'active' NOT NULL,
	`parse_error` text,
	`source_filename` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflows_project_idx` ON `workflows` (`project_id`);--> statement-breakpoint
CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`work_item_id` text,
	`workflow_run_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`destroyed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_name_active_idx` ON `worktrees` (`name`) WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_path_active_idx` ON `worktrees` (`path`) WHERE status = 'active';