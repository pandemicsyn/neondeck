CREATE TABLE `scheduled_run_workspace_snapshots` (
	`run_id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_run_workspace` ON `scheduled_run_workspace_snapshots` (`workspace_id`);