CREATE TABLE `pr_reviews` (
	`id` text PRIMARY KEY,
	`ref` text NOT NULL,
	`repo_full_name` text NOT NULL,
	`pr_number` integer NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`pr_url` text NOT NULL,
	`status` text NOT NULL,
	`attempt_id` text NOT NULL,
	`run_id` text,
	`head_sha` text NOT NULL,
	`origin` text NOT NULL,
	`review_url` text NOT NULL,
	`report_ids_json` text DEFAULT '[]' NOT NULL,
	`finding_count` integer DEFAULT 0 NOT NULL,
	`seeded_count` integer DEFAULT 0 NOT NULL,
	`report_only_count` integer DEFAULT 0 NOT NULL,
	`report_only_findings_json` text DEFAULT '[]' NOT NULL,
	`trust_boundary` text NOT NULL,
	`verdict` text,
	`previous_verdict` text,
	`github_review_url` text,
	`failure_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`ready_at` text,
	`submitted_at` text,
	`failed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pr_reviews_target` ON `pr_reviews` (`repo_full_name`,`pr_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pr_reviews_run` ON `pr_reviews` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_pr_reviews_status_updated` ON `pr_reviews` (`status`,"updated_at" DESC);
