CREATE TABLE `pr_review_workspace_outputs` (
	`output_ref` text PRIMARY KEY,
	`scope_key` text NOT NULL,
	`source` text NOT NULL,
	`payload` text NOT NULL,
	`byte_size` integer NOT NULL,
	`line_count` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pr_review_workspace_outputs_scope` ON `pr_review_workspace_outputs` (`scope_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_pr_review_workspace_outputs_expires` ON `pr_review_workspace_outputs` (`expires_at`);