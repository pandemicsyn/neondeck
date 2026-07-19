ALTER TABLE `autopilot_owner_grounding_snapshots` ADD `memory_event_rowid` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `autopilot_owner_grounding_snapshots` ADD `memory_cas_event_rowid` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `autopilot_pr_owners` ADD `grounding_memory_event_rowid` integer DEFAULT 0 NOT NULL;