CREATE TABLE `factory_delivery_pipelines` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`pipeline_id` text NOT NULL UNIQUE,
	`initial_run_id` text NOT NULL UNIQUE,
	`initial_attempt_id` text NOT NULL UNIQUE,
	`work_item_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`branch` text NOT NULL,
	`pr_number` integer,
	`record_json` text NOT NULL,
	CONSTRAINT `factory_delivery_pipelines_repo_id_branch_unique` UNIQUE(`repo_id`,`branch`),
	CONSTRAINT `factory_delivery_pipelines_repo_id_pr_number_unique` UNIQUE(`repo_id`,`pr_number`)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_coding_runs` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`run_id` text NOT NULL UNIQUE,
	`attempt_id` text NOT NULL UNIQUE,
	`request_id` text NOT NULL UNIQUE,
	`work_item_id` text NOT NULL,
	`release_id` text NOT NULL,
	`writer_slot` integer UNIQUE,
	`worktree_id` text UNIQUE,
	`record_json` text NOT NULL,
	CONSTRAINT `fk_coding_runs_worktree_id_worktrees_id_fk` FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_coding_runs`(`sequence`, `run_id`, `attempt_id`, `request_id`, `work_item_id`, `release_id`, `writer_slot`, `worktree_id`, `record_json`) SELECT `sequence`, `run_id`, `attempt_id`, `request_id`, `work_item_id`, `release_id`, `writer_slot`, `worktree_id`, `record_json` FROM `coding_runs`;--> statement-breakpoint
DROP TABLE `coding_runs`;--> statement-breakpoint
ALTER TABLE `__new_coding_runs` RENAME TO `coding_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_coding_runs_work_item` ON `coding_runs` (`work_item_id`,`sequence`);