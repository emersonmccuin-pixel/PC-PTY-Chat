-- Per MULTI-TENANCY-DESIGN.md decision #7: the Session A-N `rig` fixture is a
-- single-tenant scaffolding artifact, not a real project. Drop it (and its
-- bound rows) so first multi-tenant boot opens with zero projects.
DELETE FROM `worktrees` WHERE work_item_id IN (SELECT id FROM `work_items` WHERE project_id IN (SELECT id FROM `projects` WHERE slug = 'rig')) OR workflow_run_id IN (SELECT id FROM `workflow_runs` WHERE project_id IN (SELECT id FROM `projects` WHERE slug = 'rig'));--> statement-breakpoint
DELETE FROM `workflow_runs` WHERE project_id IN (SELECT id FROM `projects` WHERE slug = 'rig');--> statement-breakpoint
DELETE FROM `work_items` WHERE project_id IN (SELECT id FROM `projects` WHERE slug = 'rig');--> statement-breakpoint
DELETE FROM `workflows` WHERE project_id IN (SELECT id FROM `projects` WHERE slug = 'rig');--> statement-breakpoint
DELETE FROM `orchestrator_sessions` WHERE project_id IN (SELECT id FROM `projects` WHERE slug = 'rig');--> statement-breakpoint
DELETE FROM `projects` WHERE slug = 'rig';
