CREATE TABLE IF NOT EXISTS `chat_session_command_events` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`input` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text,
	`flue_run_id` text,
	`workflow_summary_id` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chat_session_command_events_session` ON `chat_session_command_events` (`session_id`,"created_at" DESC);
