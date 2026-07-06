CREATE TABLE `pr_review_neon_seeded_comments` (
	`comment_id` text PRIMARY KEY,
	`draft_id` text NOT NULL,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`path` text NOT NULL,
	`side` text NOT NULL,
	`line` integer NOT NULL,
	`start_line` integer,
	`start_side` text,
	`severity` text NOT NULL,
	`summary` text NOT NULL,
	`source` text NOT NULL,
	`outcome` text,
	`outcome_at` text,
	`seeded_at` text NOT NULL,
	CONSTRAINT `fk_pr_review_neon_seeded_comments_draft_id_pr_review_drafts_id_fk` FOREIGN KEY (`draft_id`) REFERENCES `pr_review_drafts`(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_pr_review_neon_seeded_comments_draft` ON `pr_review_neon_seeded_comments` (`draft_id`,"seeded_at" ASC);--> statement-breakpoint
CREATE INDEX `idx_pr_review_neon_seeded_comments_pr` ON `pr_review_neon_seeded_comments` (`repo`,`pr_number`,"seeded_at" ASC);