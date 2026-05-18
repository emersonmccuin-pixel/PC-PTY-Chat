ALTER TABLE `attachments` ADD `source` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `attachments` ADD `agent_name` text;--> statement-breakpoint
ALTER TABLE `attachments` ADD `node_id` text;