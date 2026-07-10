CREATE TABLE `autopilot_admissions` (
	`id` text PRIMARY KEY,
	`watch_id` text NOT NULL,
	`event_fingerprint` text NOT NULL,
	`repo_id` text NOT NULL,
	`pr_number` integer NOT NULL,
	`mode` text NOT NULL,
	`state` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`current_workflow` text,
	`current_run_id` text,
	`worktree_id` text,
	`prepared_diff_id` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_admissions_watch_event` ON `autopilot_admissions` (`watch_id`,`event_fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_autopilot_admissions_state_due` ON `autopilot_admissions` (`state`,`next_attempt_at`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_autopilot_admissions_repo_pr` ON `autopilot_admissions` (`repo_id`,`pr_number`,`state`);