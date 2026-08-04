ALTER TABLE `learning_reviews` RENAME COLUMN `flue_run_id` TO `submission_id`;--> statement-breakpoint
ALTER TABLE `learning_reviews` ADD `agent_id` text;--> statement-breakpoint
ALTER TABLE `learning_reviews` ADD `prepared_json` text;--> statement-breakpoint
ALTER TABLE `learning_reviews` ADD `dispatch_error` text;