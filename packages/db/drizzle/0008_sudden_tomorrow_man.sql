CREATE TABLE `agent_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`change_set_id` text,
	`actor` text NOT NULL,
	`field` text NOT NULL,
	`field_ref` text,
	`prior_value` text,
	`new_value` text,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_audit_agent_idx` ON `agent_audit` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_audit_change_set_idx` ON `agent_audit` (`change_set_id`);--> statement-breakpoint
CREATE TABLE `agent_knowledge` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`kind` text DEFAULT 'knowledge' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_knowledge_agent_idx` ON `agent_knowledge` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_knowledge_scope_project_idx` ON `agent_knowledge` (`scope`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_knowledge_global_name_idx` ON `agent_knowledge` (`agent_id`,`name`) WHERE scope = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX `agent_knowledge_project_name_idx` ON `agent_knowledge` (`agent_id`,`project_id`,`name`) WHERE scope = 'project';--> statement-breakpoint
CREATE TABLE `agent_mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_mcp_servers_agent_idx` ON `agent_mcp_servers` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_mcp_servers_scope_project_idx` ON `agent_mcp_servers` (`scope`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_mcp_servers_global_name_idx` ON `agent_mcp_servers` (`agent_id`,`name`) WHERE scope = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX `agent_mcp_servers_project_name_idx` ON `agent_mcp_servers` (`agent_id`,`project_id`,`name`) WHERE scope = 'project';--> statement-breakpoint
CREATE TABLE `agent_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`env_var_name` text NOT NULL,
	`value_plaintext` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_secrets_agent_idx` ON `agent_secrets` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_secrets_scope_project_idx` ON `agent_secrets` (`scope`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_secrets_global_env_idx` ON `agent_secrets` (`agent_id`,`env_var_name`) WHERE scope = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX `agent_secrets_project_env_idx` ON `agent_secrets` (`agent_id`,`project_id`,`env_var_name`) WHERE scope = 'project';--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`prompt` text DEFAULT '' NOT NULL,
	`tools_json` text DEFAULT '[]' NOT NULL,
	`model` text,
	`effort` text,
	`max_turns` integer,
	`output_destination` text,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_global_name_idx` ON `agents` (`name`) WHERE scope = 'global' AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_project_name_idx` ON `agents` (`project_id`,`name`) WHERE scope = 'project' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `agents_scope_project_idx` ON `agents` (`scope`,`project_id`);