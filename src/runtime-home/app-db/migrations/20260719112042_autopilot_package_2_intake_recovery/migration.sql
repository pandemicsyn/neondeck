CREATE TABLE `pr_neondeck_deliveries` (
	`repo_full_name` text NOT NULL,
	`pr_number` integer NOT NULL,
	`item_kind` text NOT NULL,
	`item_id` text NOT NULL,
	`item_fingerprint` text NOT NULL,
	`delivered_at` text NOT NULL,
	CONSTRAINT `pr_neondeck_deliveries_pk` PRIMARY KEY(`repo_full_name`, `pr_number`, `item_kind`, `item_id`)
);
--> statement-breakpoint
CREATE TABLE `pr_watch_event_intakes` (
	`event_id` text PRIMARY KEY,
	`watch_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`repo_full_name` text NOT NULL,
	`pr_number` integer NOT NULL,
	`source` text NOT NULL,
	`initial_event` integer DEFAULT 0 NOT NULL,
	`previous_watermarks_json` text NOT NULL,
	`candidate_watermarks_json` text NOT NULL,
	`changed_categories_json` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`acknowledged_at` text,
	`outcome` text,
	`admission_id` text,
	`notification_id` text,
	`superseded_reason` text
);
--> statement-breakpoint
ALTER TABLE `pr_watches` ADD `event_watermark_version` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
UPDATE `pr_watches` SET `event_watermark_version` = 1;--> statement-breakpoint
CREATE INDEX `idx_pr_neondeck_deliveries_target` ON `pr_neondeck_deliveries` (`repo_full_name`,`pr_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pr_watch_event_intakes_one_pending` ON `pr_watch_event_intakes` (`watch_id`) WHERE "pr_watch_event_intakes"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pr_watch_event_intakes_sequence` ON `pr_watch_event_intakes` (`watch_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_pr_watch_event_intakes_pending` ON `pr_watch_event_intakes` (`status`,`updated_at`);
