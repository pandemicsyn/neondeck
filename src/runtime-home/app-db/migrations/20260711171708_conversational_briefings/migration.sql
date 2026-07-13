CREATE TABLE `briefing_profiles` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`instructions` text NOT NULL,
	`instructions_version` integer DEFAULT 1 NOT NULL,
	`schedule` text NOT NULL,
	`timezone` text NOT NULL,
	`session_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `briefing_runs` (
	`id` text PRIMARY KEY,
	`profile_id` text,
	`trigger` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`instructions` text NOT NULL,
	`instructions_version` integer NOT NULL,
	`session_id` text NOT NULL,
	`command_event_id` text,
	`dispatch_id` text,
	`workflow_run_id` text,
	`status` text NOT NULL,
	`error` text,
	`queued_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_briefing_runs_profile` ON `briefing_runs` (`profile_id`,"created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_briefing_runs_dispatch` ON `briefing_runs` (`dispatch_id`);--> statement-breakpoint
CREATE INDEX `idx_briefing_runs_status` ON `briefing_runs` (`status`,"updated_at" DESC);