CREATE TABLE `autopilot_owner_fix_submissions` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`admission_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`dispatch_id` text,
	`token_hash` text NOT NULL,
	`disposition` text NOT NULL,
	`status` text NOT NULL,
	`request_hash` text NOT NULL,
	`mutation_epoch` integer DEFAULT 0 NOT NULL,
	`prepared_diff_id` text,
	`result_json` text DEFAULT '{}' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`finished_at` text,
	`cancellation_requested_at` text,
	`mutation_started_at` text,
	`mutation_revision_key` text,
	`artifact_revision_key` text,
	CONSTRAINT "autopilot_owner_fix_disposition_check" CHECK("disposition" IN ('fix', 'no-op')),
	CONSTRAINT "autopilot_owner_fix_status_check" CHECK("status" IN ('applying', 'prepared', 'no-op', 'rejected', 'failed', 'cancelled')),
	CONSTRAINT "autopilot_owner_fix_mutation_epoch_check" CHECK("mutation_epoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE `autopilot_owner_generations` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`generation` integer NOT NULL,
	`flue_instance_id` text NOT NULL,
	`status` text NOT NULL,
	`rotation_reason` text,
	`handoff_json` text DEFAULT '{}' NOT NULL,
	`capability_hash` text NOT NULL,
	`capability_json` text NOT NULL,
	`created_at` text NOT NULL,
	`archived_at` text,
	CONSTRAINT "autopilot_owner_generations_status_check" CHECK("status" IN ('active', 'archived', 'failed')),
	CONSTRAINT "autopilot_owner_generations_number_check" CHECK("generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE `autopilot_owner_grounding_snapshots` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`admission_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`generation` integer NOT NULL,
	`flue_instance_id` text NOT NULL,
	`worktree_id` text,
	`pr_head_sha` text,
	`worktree_head_sha` text,
	`base_sha` text,
	`checkout_branch` text,
	`checkout_detached` integer,
	`diff_base_sha` text,
	`diff_revision_key` text,
	`repo_binding_hash` text,
	`workspace_binding_hash` text,
	`config_history_id` integer NOT NULL,
	`memory_event_at` text,
	`memory_event_id` text,
	`memory_event_sequence` integer DEFAULT 0 NOT NULL,
	`memory_cas_event_at` text,
	`memory_cas_event_id` text,
	`memory_cas_event_sequence` integer DEFAULT 0 NOT NULL,
	`memory_ids_json` text DEFAULT '[]' NOT NULL,
	`stale_reasons_json` text DEFAULT '[]' NOT NULL,
	`envelope_hash` text NOT NULL,
	`policy_hash` text NOT NULL,
	`submit_token_hash` text NOT NULL,
	`status` text NOT NULL,
	`dispatch_id` text,
	`accepted_at` text,
	`created_at` text NOT NULL,
	CONSTRAINT "autopilot_grounding_status_check" CHECK("status" IN ('reserved', 'accepted', 'blocked', 'orphaned'))
);
--> statement-breakpoint
ALTER TABLE `autopilot_admissions` ADD `authority_mode` text;--> statement-breakpoint
ALTER TABLE `autopilot_admissions` ADD `policy_config_history_id` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `autopilot_admissions` ADD `mutation_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `autopilot_pr_owners` ADD `grounding_memory_event_sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_events` ADD `sequence` integer;--> statement-breakpoint
CREATE TRIGGER `autopilot_admissions_package_4_insert_check`
BEFORE INSERT ON `autopilot_admissions`
WHEN NEW.`authority_mode` IS NOT NULL AND NEW.`authority_mode` NOT IN ('notify-only', 'prepare-only', 'autofix-with-approval', 'autofix-push-when-safe') OR NEW.`mutation_epoch` < 0
BEGIN SELECT RAISE(ABORT, 'autopilot Package 4 authority constraint failed'); END;--> statement-breakpoint
CREATE TRIGGER `autopilot_admissions_package_4_update_check`
BEFORE UPDATE OF `authority_mode`, `mutation_epoch` ON `autopilot_admissions`
WHEN NEW.`authority_mode` IS NOT NULL AND NEW.`authority_mode` NOT IN ('notify-only', 'prepare-only', 'autofix-with-approval', 'autofix-push-when-safe') OR NEW.`mutation_epoch` < 0
BEGIN SELECT RAISE(ABORT, 'autopilot Package 4 authority constraint failed'); END;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memory_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL,
	`memory_id` text,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text,
	`before_json` text,
	`after_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_memory_events`(`sequence`, `id`, `memory_id`, `action`, `actor`, `reason`, `before_json`, `after_json`, `created_at`) SELECT `rowid`, `id`, `memory_id`, `action`, `actor`, `reason`, `before_json`, `after_json`, `created_at` FROM `memory_events` ORDER BY `rowid`;--> statement-breakpoint
DROP TABLE `memory_events`;--> statement-breakpoint
ALTER TABLE `__new_memory_events` RENAME TO `memory_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_memory_events_id` ON `memory_events` (`id`);--> statement-breakpoint
CREATE INDEX `idx_memory_events_changed` ON `memory_events` ("created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_owner_fix_attempt` ON `autopilot_owner_fix_submissions` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_owner_fix_token` ON `autopilot_owner_fix_submissions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_autopilot_owner_fix_owner` ON `autopilot_owner_fix_submissions` (`owner_id`,"created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_owner_generations_number` ON `autopilot_owner_generations` (`owner_id`,`generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_owner_generations_instance` ON `autopilot_owner_generations` (`flue_instance_id`);--> statement-breakpoint
CREATE INDEX `idx_autopilot_owner_generations_owner` ON `autopilot_owner_generations` (`owner_id`,"generation" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_grounding_attempt` ON `autopilot_owner_grounding_snapshots` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_grounding_dispatch` ON `autopilot_owner_grounding_snapshots` (`dispatch_id`) WHERE "autopilot_owner_grounding_snapshots"."dispatch_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_autopilot_grounding_owner` ON `autopilot_owner_grounding_snapshots` (`owner_id`,"created_at" DESC);
