CREATE TABLE `pr_review_draft_comments` (
	`id` text PRIMARY KEY,
	`draft_id` text NOT NULL,
	`path` text NOT NULL,
	`side` text NOT NULL,
	`line` integer NOT NULL,
	`start_line` integer,
	`start_side` text,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_pr_review_draft_comments_draft_id_pr_review_drafts_id_fk` FOREIGN KEY (`draft_id`) REFERENCES `pr_review_drafts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `pr_review_drafts` (
	`id` text PRIMARY KEY,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`verdict` text,
	`body` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`submitted_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_pr_review_draft_comments_draft` ON `pr_review_draft_comments` (`draft_id`,"created_at" ASC);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pr_review_drafts_live` ON `pr_review_drafts` (`repo`,`pr_number`) WHERE "pr_review_drafts"."status" = 'draft';--> statement-breakpoint
CREATE INDEX `idx_pr_review_drafts_pr` ON `pr_review_drafts` (`repo`,`pr_number`,"updated_at" DESC);