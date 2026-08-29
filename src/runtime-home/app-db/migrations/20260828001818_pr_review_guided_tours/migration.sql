CREATE TABLE `pr_review_tour_publications` (
	`tool_call_id` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`tour_id` text NOT NULL,
	`generation` integer NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pr_review_tour_steps` (
	`id` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`key` text NOT NULL,
	`ordinal` integer NOT NULL,
	`file` text NOT NULL,
	`side` text NOT NULL,
	`start_line` integer NOT NULL,
	`end_line` integer NOT NULL,
	`symbol` text,
	`explanation` text NOT NULL,
	CONSTRAINT `fk_pr_review_tour_steps_conversation_id_pr_review_tours_conversation_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `pr_review_tours`(`conversation_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `pr_review_tours` (
	`conversation_id` text PRIMARY KEY,
	`id` text NOT NULL,
	`generation` integer NOT NULL,
	`review_id` text NOT NULL,
	`repo_full_name` text NOT NULL,
	`head_sha` text NOT NULL,
	`revision_key` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`source_finding_id` text,
	`author_role` text NOT NULL,
	`model` text,
	`submission_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pr_review_tour_publications_conversation` ON `pr_review_tour_publications` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pr_review_tour_steps_key` ON `pr_review_tour_steps` (`conversation_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pr_review_tour_steps_ordinal` ON `pr_review_tour_steps` (`conversation_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pr_review_tours_id` ON `pr_review_tours` (`id`);--> statement-breakpoint
CREATE INDEX `idx_pr_review_tours_review_revision` ON `pr_review_tours` (`review_id`,`head_sha`);