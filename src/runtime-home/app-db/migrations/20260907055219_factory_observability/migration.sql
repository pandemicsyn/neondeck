CREATE TABLE `factory_diagnostics` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`work_item_id` text,
	`finished_at` text NOT NULL,
	`record_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `factory_worker_health` (
	`worker` text PRIMARY KEY,
	`record_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_factory_diagnostics_work` ON `factory_diagnostics` (`work_item_id`,`sequence`);