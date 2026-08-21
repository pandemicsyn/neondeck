ALTER TABLE `pr_review_drafts` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `pr_reviews` ADD `submission_draft_revision` integer;