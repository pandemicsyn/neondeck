PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_autopilot_admissions` (
	`id` text PRIMARY KEY,
	`owner_id` text NOT NULL,
	`watch_id` text NOT NULL,
	`event_fingerprint` text NOT NULL,
	`event_sequence` integer NOT NULL,
	`repo_id` text NOT NULL,
	`pr_number` integer NOT NULL,
	`mode` text NOT NULL,
	`input_json` text DEFAULT '{}' NOT NULL,
	`state` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`current_workflow` text,
	`current_run_id` text,
	`current_stage_attempt_id` text,
	`worktree_id` text,
	`prepared_diff_id` text,
	`fixer_kind` text,
	`version` integer DEFAULT 1 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_error` text,
	`last_outcome_json` text,
	`stop_requested_at` text,
	`completed_at` text,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `autopilot_admissions_id_owner_unique` UNIQUE(`id`,`owner_id`),
	CONSTRAINT "autopilot_admissions_state_check" CHECK("state" IN ('triage-admitted', 'triaged', 'prepare-admitted', 'prepared', 'owner-turn-admitted', 'owner-turn-running', 'fix-prepared', 'verify-admitted', 'verified', 'approval-pending', 'push-admitted', 'pushed', 'comment-admitted', 'completed', 'cleanup-pending', 'archived', 'blocked', 'manual-review', 'failed', 'stopped', 'superseded')),
	CONSTRAINT "autopilot_admissions_mode_check" CHECK("mode" IN ('notify-only', 'prepare-only', 'autofix-with-approval', 'autofix-push-when-safe')),
	CONSTRAINT "autopilot_admissions_fixer_kind_check" CHECK("fixer_kind" IS NULL OR "fixer_kind" IN ('neon-owner', 'kilo')),
	CONSTRAINT "autopilot_admissions_version_check" CHECK("version" >= 1),
	CONSTRAINT "autopilot_admissions_sequence_check" CHECK("event_sequence" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_autopilot_admissions`(`id`, `owner_id`, `watch_id`, `event_fingerprint`, `event_sequence`, `repo_id`, `pr_number`, `mode`, `input_json`, `state`, `priority`, `current_workflow`, `current_run_id`, `current_stage_attempt_id`, `worktree_id`, `prepared_diff_id`, `fixer_kind`, `version`, `attempt_count`, `next_attempt_at`, `last_error`, `last_outcome_json`, `stop_requested_at`, `completed_at`, `archived_at`, `created_at`, `updated_at`) SELECT `id`, `owner_id`, `watch_id`, `event_fingerprint`, `event_sequence`, `repo_id`, `pr_number`, `mode`, `input_json`, `state`, `priority`, `current_workflow`, `current_run_id`, `current_stage_attempt_id`, `worktree_id`, `prepared_diff_id`, `fixer_kind`, `version`, `attempt_count`, `next_attempt_at`, `last_error`, `last_outcome_json`, `stop_requested_at`, `completed_at`, `archived_at`, `created_at`, `updated_at` FROM `autopilot_admissions`;--> statement-breakpoint
DROP TABLE `autopilot_admissions`;--> statement-breakpoint
ALTER TABLE `__new_autopilot_admissions` RENAME TO `autopilot_admissions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_autopilot_stage_attempts` (
	`id` text PRIMARY KEY,
	`admission_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`stage` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`workflow` text,
	`run_id` text,
	`flue_instance_id` text,
	`owner_generation` integer,
	`event_sequence` integer,
	`dispatch_id` text,
	`status` text NOT NULL,
	`input_fingerprint` text NOT NULL,
	`artifact_json` text DEFAULT '{}' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	CONSTRAINT `autopilot_stage_attempts_admission_owner_fk` FOREIGN KEY (`admission_id`,`owner_id`) REFERENCES `autopilot_admissions`(`id`,`owner_id`),
	CONSTRAINT "autopilot_stage_attempts_stage_check" CHECK("stage" IN ('triage', 'prepare-worktree', 'owner-turn', 'verify', 'push', 'comment-result', 'cleanup')),
	CONSTRAINT "autopilot_stage_attempts_status_check" CHECK("status" IN ('reserved', 'running', 'completed', 'blocked', 'failed', 'cancelled')),
	CONSTRAINT "autopilot_stage_attempts_number_check" CHECK("attempt_number" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_autopilot_stage_attempts`(`id`, `admission_id`, `owner_id`, `stage`, `attempt_number`, `workflow`, `run_id`, `flue_instance_id`, `owner_generation`, `event_sequence`, `dispatch_id`, `status`, `input_fingerprint`, `artifact_json`, `error`, `created_at`, `started_at`, `finished_at`) SELECT `id`, `admission_id`, `owner_id`, `stage`, `attempt_number`, `workflow`, `run_id`, `flue_instance_id`, `owner_generation`, `event_sequence`, `dispatch_id`, `status`, `input_fingerprint`, `artifact_json`, `error`, `created_at`, `started_at`, `finished_at` FROM `autopilot_stage_attempts`;--> statement-breakpoint
DROP TABLE `autopilot_stage_attempts`;--> statement-breakpoint
ALTER TABLE `__new_autopilot_stage_attempts` RENAME TO `autopilot_stage_attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_admissions_watch_event` ON `autopilot_admissions` (`watch_id`,`event_fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_autopilot_admissions_state_due` ON `autopilot_admissions` (`state`,`next_attempt_at`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_autopilot_admissions_repo_pr` ON `autopilot_admissions` (`repo_id`,`pr_number`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_admissions_owner_sequence` ON `autopilot_admissions` (`owner_id`,`event_sequence`);--> statement-breakpoint
CREATE INDEX `idx_autopilot_admissions_owner_state` ON `autopilot_admissions` (`owner_id`,`state`,"updated_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_stage_attempts_number` ON `autopilot_stage_attempts` (`admission_id`,`stage`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_stage_attempts_run` ON `autopilot_stage_attempts` (`run_id`) WHERE "autopilot_stage_attempts"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_stage_attempts_dispatch` ON `autopilot_stage_attempts` (`dispatch_id`) WHERE "autopilot_stage_attempts"."dispatch_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_stage_attempts_owner_active` ON `autopilot_stage_attempts` (`owner_id`) WHERE "autopilot_stage_attempts"."status" IN ('reserved', 'running');--> statement-breakpoint
CREATE INDEX `idx_autopilot_stage_attempts_admission` ON `autopilot_stage_attempts` (`admission_id`,`stage`,"attempt_number" DESC);--> statement-breakpoint
CREATE INDEX `idx_autopilot_stage_attempts_status` ON `autopilot_stage_attempts` (`status`,`created_at`);--> statement-breakpoint
INSERT INTO `app_metadata` (`key`, `value`, `updated_at`)
SELECT
	'autopilot.stage.terminal:' || admission.`current_run_id`,
	legacy.`value`,
	legacy.`updated_at`
FROM `autopilot_admissions` AS admission
JOIN `app_metadata` AS legacy
	ON legacy.`key` = 'autopilot.admission.terminal:' || admission.`current_run_id`
WHERE admission.`state` IN ('triage-admitted', 'prepare-admitted')
	AND admission.`current_stage_attempt_id` IS NOT NULL
	AND admission.`current_run_id` IS NOT NULL
ON CONFLICT(`key`) DO NOTHING;
