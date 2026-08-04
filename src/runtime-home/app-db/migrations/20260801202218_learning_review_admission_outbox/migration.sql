CREATE TABLE `learning_review_admissions` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`session_id` text,
	`input_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_learning_review_admissions_pending` ON `learning_review_admissions` (`status`,`created_at`);