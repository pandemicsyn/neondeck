ALTER TABLE `scheduled_task_runs` ADD `submission_id` text;--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` DROP COLUMN `workflow_run_id`;
