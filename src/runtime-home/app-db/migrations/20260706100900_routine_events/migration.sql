CREATE TABLE `routine_events` (
	`id` text PRIMARY KEY,
	`routine_id` text,
	`run_id` text,
	`event_type` text NOT NULL,
	`message` text NOT NULL,
	`actor` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_routine_events_routine` ON `routine_events` (`routine_id`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_routine_events_created` ON `routine_events` ("created_at" DESC);