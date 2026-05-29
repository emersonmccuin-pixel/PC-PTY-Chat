-- Agent lifecycle hardening: persist the spawned OS pid + last JSONL activity
-- on agent_runs so the continuous liveness sweep can (a) probe process
-- existence for in-process runs and (b) flag alive-but-idle (wedged) runs.
ALTER TABLE `agent_runs` ADD `pid` integer;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `last_activity_at` integer;
