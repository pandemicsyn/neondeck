ALTER TABLE `pr_reviews` ADD `submission_draft_id` text;--> statement-breakpoint
ALTER TABLE `pr_reviews` ADD `submission_draft_updated_at` text;--> statement-breakpoint
DROP INDEX `idx_pr_review_drafts_live`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pr_review_drafts_live` ON `pr_review_drafts` (`repo`,`pr_number`) WHERE `status` IN ('draft', 'submitting');
