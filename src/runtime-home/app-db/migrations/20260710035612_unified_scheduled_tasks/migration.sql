CREATE TABLE `scheduled_task_runs` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`status` text NOT NULL,
	`outcome` text NOT NULL,
	`message` text NOT NULL,
	`workflow_run_id` text,
	`session_id` text,
	`result_json` text,
	`error` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`trigger_json` text NOT NULL,
	`payload_json` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`next_run_at` text,
	`claim_id` text,
	`claim_expires_at` text,
	`last_run_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_task_runs_task` ON `scheduled_task_runs` (`task_id`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_scheduled_task_runs_status` ON `scheduled_task_runs` (`status`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_due` ON `scheduled_tasks` (`enabled`,`next_run_at`,`claim_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_kind` ON `scheduled_tasks` (`kind`,`enabled`);