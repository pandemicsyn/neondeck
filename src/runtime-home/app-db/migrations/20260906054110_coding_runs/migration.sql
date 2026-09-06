CREATE TABLE `coding_run_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`run_id` text NOT NULL,
	`version` integer NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_coding_run_events_run_id_coding_runs_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `coding_runs`(`run_id`)
);
--> statement-breakpoint
CREATE TABLE `coding_runs` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`run_id` text NOT NULL UNIQUE,
	`attempt_id` text NOT NULL UNIQUE,
	`request_id` text NOT NULL UNIQUE,
	`work_item_id` text NOT NULL,
	`release_id` text NOT NULL UNIQUE,
	`writer_slot` integer UNIQUE,
	`worktree_id` text UNIQUE,
	`record_json` text NOT NULL,
	CONSTRAINT `fk_coding_runs_worktree_id_worktrees_id_fk` FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_coding_run_events_run` ON `coding_run_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_coding_runs_work_item` ON `coding_runs` (`work_item_id`,`sequence`);