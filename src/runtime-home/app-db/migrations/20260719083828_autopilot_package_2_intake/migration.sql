CREATE TABLE `pr_feedback_addressing` (
	`repo_full_name` text NOT NULL,
	`pr_number` integer NOT NULL,
	`item_kind` text NOT NULL,
	`item_id` text NOT NULL,
	`item_fingerprint` text NOT NULL,
	`delivery_comment_id` text,
	`addressed_at` text NOT NULL,
	CONSTRAINT `pr_feedback_addressing_pk` PRIMARY KEY(`repo_full_name`, `pr_number`, `item_kind`, `item_id`)
);
--> statement-breakpoint
ALTER TABLE `pr_watches` ADD `process_existing` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pr_watches` ADD `initial_event_processed_at` text;--> statement-breakpoint
UPDATE `pr_watches`
SET `initial_event_processed_at` = `updated_at`
WHERE `initial_event_processed_at` IS NULL;--> statement-breakpoint
CREATE INDEX `idx_pr_feedback_addressing_target` ON `pr_feedback_addressing` (`repo_full_name`,`pr_number`);
