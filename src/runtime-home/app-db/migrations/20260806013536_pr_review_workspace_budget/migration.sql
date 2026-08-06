CREATE TABLE `pr_review_workspace_budgets` (
	`budget_key` text PRIMARY KEY,
	`calls_used` integer DEFAULT 0 NOT NULL,
	`call_limit` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pr_review_workspace_budgets_updated` ON `pr_review_workspace_budgets` (`updated_at`);