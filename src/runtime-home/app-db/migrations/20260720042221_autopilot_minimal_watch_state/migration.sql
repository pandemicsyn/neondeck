ALTER TABLE `pr_watches` ADD `autopilot_mode` text DEFAULT 'notify-only' NOT NULL;--> statement-breakpoint
ALTER TABLE `pr_watches` ADD `autopilot_status` text DEFAULT 'watching' NOT NULL;--> statement-breakpoint
ALTER TABLE `pr_watches` ADD `owner_instance_id` text;--> statement-breakpoint
ALTER TABLE `pr_watches` ADD `worktree_id` text;--> statement-breakpoint
ALTER TABLE `pr_watches` ADD `last_event_fingerprint` text;