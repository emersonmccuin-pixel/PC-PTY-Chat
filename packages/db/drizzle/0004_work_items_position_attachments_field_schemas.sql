CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`content_type` text,
	`run_id` text,
	`created_by_session_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attachments_work_item_idx` ON `attachments` (`work_item_id`);--> statement-breakpoint
CREATE TABLE `field_schemas` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`options` text,
	`default` text,
	`required` integer DEFAULT false NOT NULL,
	`description` text,
	`order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `field_schemas_project_idx` ON `field_schemas` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `field_schemas_project_key_idx` ON `field_schemas` (`project_id`,`key`);--> statement-breakpoint
ALTER TABLE `work_items` ADD `position` integer DEFAULT 0 NOT NULL;