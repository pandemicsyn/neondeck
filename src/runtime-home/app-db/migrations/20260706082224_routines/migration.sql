CREATE TABLE `routine_runs` (
	`id` text PRIMARY KEY,
	`routine_id` text NOT NULL,
	`status` text NOT NULL,
	`outcome` text,
	`message` text NOT NULL,
	`report_id` text,
	`session_id` text,
	`command_event_id` text,
	`dispatch_id` text,
	`summary_json` text,
	`error` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `routines` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`schedule_kind` text NOT NULL,
	`schedule` text NOT NULL,
	`skills_json` text,
	`scope_repo_id` text,
	`scope_cwd` text,
	`delivery` text NOT NULL,
	`session_id` text,
	`repeat_limit` integer,
	`run_count` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`running_run_id` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_run_at` text,
	`next_run_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_routine_runs_routine` ON `routine_runs` (`routine_id`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_routine_runs_status` ON `routine_runs` (`status`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_routines_due` ON `routines` (`enabled`,`next_run_at`,`running_run_id`);--> statement-breakpoint
CREATE INDEX `idx_routines_updated` ON `routines` ("updated_at" DESC);
