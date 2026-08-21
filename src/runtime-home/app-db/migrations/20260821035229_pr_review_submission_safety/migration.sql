CREATE TABLE `pr_review_submission_followups` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
ALTER TABLE `pr_reviews` ADD `submission_draft_id` text;--> statement-breakpoint
ALTER TABLE `pr_reviews` ADD `submission_draft_updated_at` text;--> statement-breakpoint
CREATE INDEX `idx_pr_review_submission_followups_pending` ON `pr_review_submission_followups` (`status`,`kind`,`created_at`);--> statement-breakpoint
DROP INDEX `idx_pr_review_drafts_live`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pr_review_drafts_live` ON `pr_review_drafts` (`repo`,`pr_number`) WHERE `pr_review_drafts`.`status` IN ('draft', 'submitting');
