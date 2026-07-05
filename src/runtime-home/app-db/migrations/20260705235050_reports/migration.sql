CREATE TABLE `reports` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`repo_id` text,
	`source_ref` text,
	`html_path` text NOT NULL,
	`summary_json` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_reports_kind_created` ON `reports` (`kind`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_reports_repo_created` ON `reports` (`repo_id`,"created_at" DESC);