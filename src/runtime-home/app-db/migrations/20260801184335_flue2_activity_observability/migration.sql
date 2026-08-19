CREATE TABLE `activity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`submission_id` text,
	`agent_name` text,
	`instance_id` text,
	`conversation_id` text,
	`event_type` text NOT NULL,
	`event_index` integer,
	`level` text,
	`message` text NOT NULL,
	`name` text,
	`operation_kind` text,
	`operation_id` text,
	`duration_ms` integer,
	`is_error` integer DEFAULT 0 NOT NULL,
	`summary_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `activity_submissions` (
	`submission_id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`agent_name` text,
	`instance_id` text,
	`status` text NOT NULL,
	`queued_at` text NOT NULL,
	`started_at` text,
	`settled_at` text,
	`last_event_at` text NOT NULL,
	`last_message` text NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`is_error` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_workflow_events_run`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_workflow_events_created`;--> statement-breakpoint
CREATE INDEX `idx_activity_events_submission` ON `activity_events` (`submission_id`,`event_index`);--> statement-breakpoint
CREATE INDEX `idx_activity_events_created` ON `activity_events` ("created_at" DESC);--> statement-breakpoint
DROP TABLE `workflow_events`;--> statement-breakpoint
DROP TABLE `workflow_run_observations`;