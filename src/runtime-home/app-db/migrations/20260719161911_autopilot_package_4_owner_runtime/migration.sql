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
	`prepared_diff_id` text,
	`result_json` text DEFAULT '{}' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`finished_at` text,
	CONSTRAINT "autopilot_owner_fix_disposition_check" CHECK("disposition" IN ('fix', 'no-op')),
	CONSTRAINT "autopilot_owner_fix_status_check" CHECK("status" IN ('applying', 'prepared', 'no-op', 'rejected', 'failed'))
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
	`config_history_id` integer NOT NULL,
	`memory_event_at` text,
	`memory_event_id` text,
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
CREATE UNIQUE INDEX `idx_autopilot_owner_fix_attempt` ON `autopilot_owner_fix_submissions` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_owner_fix_token` ON `autopilot_owner_fix_submissions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_autopilot_owner_fix_owner` ON `autopilot_owner_fix_submissions` (`owner_id`,"created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_owner_generations_number` ON `autopilot_owner_generations` (`owner_id`,`generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_owner_generations_instance` ON `autopilot_owner_generations` (`flue_instance_id`);--> statement-breakpoint
CREATE INDEX `idx_autopilot_owner_generations_owner` ON `autopilot_owner_generations` (`owner_id`,"generation" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_grounding_attempt` ON `autopilot_owner_grounding_snapshots` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_grounding_dispatch` ON `autopilot_owner_grounding_snapshots` (`dispatch_id`) WHERE "autopilot_owner_grounding_snapshots"."dispatch_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_autopilot_grounding_owner` ON `autopilot_owner_grounding_snapshots` (`owner_id`,"created_at" DESC);