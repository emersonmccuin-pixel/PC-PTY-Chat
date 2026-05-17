ALTER TABLE `orchestrator_sessions` ADD `jsonl_path` text;--> statement-breakpoint
ALTER TABLE `orchestrator_sessions` ADD `jsonl_line_cursor` integer DEFAULT 0 NOT NULL;