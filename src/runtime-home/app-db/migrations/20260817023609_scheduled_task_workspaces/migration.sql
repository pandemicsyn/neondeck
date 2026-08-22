CREATE TABLE `scheduled_run_artifacts` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`workspace_id` text,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`content` text,
	`truncated` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_workspaces` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`owning_run_id` text,
	`provider_id` text NOT NULL,
	`provider_resource_id` text NOT NULL,
	`resource_metadata_json` text NOT NULL,
	`lifecycle` text NOT NULL,
	`repo_id` text NOT NULL,
	`workspace_root` text NOT NULL,
	`requested_ref` text NOT NULL,
	`revision_mode` text NOT NULL,
	`git_mode` text NOT NULL,
	`branch_name` text,
	`base_sha` text,
	`initial_sha` text,
	`final_sha` text,
	`dirty` integer,
	`local_worktree_id` text,
	`authority` text NOT NULL,
	`retention` text NOT NULL,
	`status` text NOT NULL,
	`lock_owner` text,
	`lock_expires_at` text,
	`retention_reason` text,
	`provider_error` text,
	`created_at` text NOT NULL,
	`last_used_at` text NOT NULL,
	`retained_at` text,
	`cleanup_attempted_at` text,
	`deleted_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_run_artifacts_run` ON `scheduled_run_artifacts` (`run_id`,"created_at" ASC);--> statement-breakpoint
CREATE INDEX `idx_task_workspaces_task` ON `task_workspaces` (`task_id`,`status`,"updated_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_workspaces_run` ON `task_workspaces` (`owning_run_id`) WHERE "task_workspaces"."owning_run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_workspaces_lock` ON `task_workspaces` (`task_id`) WHERE "task_workspaces"."lock_owner" IS NOT NULL;