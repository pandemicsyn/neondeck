CREATE TABLE `autopilot_admission_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`admission_id` text NOT NULL,
	`from_state` text,
	`to_state` text NOT NULL,
	`reason` text NOT NULL,
	`workflow` text,
	`run_id` text,
	`data_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `autopilot_pr_owners` (
	`id` text PRIMARY KEY,
	`watch_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`pr_number` integer NOT NULL,
	`flue_agent` text DEFAULT 'pr-autopilot-owner' NOT NULL,
	`flue_instance_id` text,
	`chat_session_id` text,
	`worktree_id` text,
	`generation` integer DEFAULT 1 NOT NULL,
	`grounding_config_history_id` integer DEFAULT 0 NOT NULL,
	`grounding_memory_event_at` text,
	`grounding_memory_event_id` text,
	`grounding_memory_ids_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'awaiting-event' NOT NULL,
	`current_head_sha` text,
	`last_dispatched_sequence` integer DEFAULT 0 NOT NULL,
	`last_settled_sequence` integer DEFAULT 0 NOT NULL,
	`last_event_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	CONSTRAINT "autopilot_pr_owners_status_check" CHECK("status" IN ('awaiting-event', 'active', 'draining', 'archived', 'failed')),
	CONSTRAINT "autopilot_pr_owners_generation_check" CHECK("generation" >= 1),
	CONSTRAINT "autopilot_pr_owners_sequence_check" CHECK("last_dispatched_sequence" >= 0 AND "last_settled_sequence" >= 0 AND "last_settled_sequence" <= "last_dispatched_sequence")
);
--> statement-breakpoint
CREATE TABLE `autopilot_stage_attempts` (
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
	CONSTRAINT "autopilot_stage_attempts_stage_check" CHECK("stage" IN ('triage', 'prepare-worktree', 'owner-turn', 'verify', 'push', 'comment-result', 'cleanup')),
	CONSTRAINT "autopilot_stage_attempts_status_check" CHECK("status" IN ('reserved', 'running', 'completed', 'blocked', 'failed', 'cancelled')),
	CONSTRAINT "autopilot_stage_attempts_number_check" CHECK("attempt_number" >= 1)
);
--> statement-breakpoint
INSERT INTO `autopilot_pr_owners` (
	`id`, `watch_id`, `repo_id`, `pr_number`, `flue_agent`, `generation`,
	`grounding_config_history_id`, `grounding_memory_ids_json`, `status`,
	`last_dispatched_sequence`, `last_settled_sequence`, `last_event_at`,
	`created_at`, `updated_at`
)
SELECT
	'autopilot-owner:migrated:' || lower(hex(randomblob(16))),
	`watch_id`, MIN(`repo_id`), MIN(`pr_number`), 'pr-autopilot-owner', 1,
	0, '[]', 'awaiting-event', 0, 0, MAX(`updated_at`), MIN(`created_at`), MAX(`updated_at`)
FROM `autopilot_admissions`
GROUP BY `watch_id`;--> statement-breakpoint
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
	CONSTRAINT "autopilot_admissions_state_check" CHECK("state" IN ('triage-admitted', 'triaged', 'prepare-admitted', 'prepared', 'owner-turn-admitted', 'owner-turn-running', 'fix-prepared', 'verify-admitted', 'verified', 'approval-pending', 'push-admitted', 'pushed', 'comment-admitted', 'completed', 'cleanup-pending', 'archived', 'blocked', 'manual-review', 'failed', 'stopped', 'superseded')),
	CONSTRAINT "autopilot_admissions_mode_check" CHECK("mode" IN ('notify-only', 'prepare-only', 'autofix-with-approval', 'autofix-push-when-safe')),
	CONSTRAINT "autopilot_admissions_version_check" CHECK("version" >= 1),
	CONSTRAINT "autopilot_admissions_sequence_check" CHECK("event_sequence" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_autopilot_admissions`(
	`id`, `owner_id`, `watch_id`, `event_fingerprint`, `event_sequence`,
	`repo_id`, `pr_number`, `mode`, `input_json`, `state`, `priority`,
	`current_workflow`, `current_run_id`, `current_stage_attempt_id`,
	`worktree_id`, `prepared_diff_id`, `version`, `attempt_count`,
	`next_attempt_at`, `last_error`, `last_outcome_json`, `completed_at`,
	`created_at`, `updated_at`
)
WITH ranked AS (
	SELECT
		a.*,
		owner.`id` AS `durable_owner_id`,
		ROW_NUMBER() OVER (
			PARTITION BY a.`watch_id` ORDER BY a.`created_at`, a.`id`
		) AS `durable_event_sequence`,
		ROW_NUMBER() OVER (
			PARTITION BY a.`watch_id`, a.`state` IN ('triage-admitted', 'prepare-admitted')
			ORDER BY a.`updated_at` DESC, a.`id` DESC
		) AS `active_rank`
	FROM `autopilot_admissions` AS a
	JOIN `autopilot_pr_owners` AS owner ON owner.`watch_id` = a.`watch_id`
)
SELECT
	a.`id`, a.`durable_owner_id`, a.`watch_id`, a.`event_fingerprint`,
	a.`durable_event_sequence`,
	a.`repo_id`, a.`pr_number`, a.`mode`, a.`input_json`,
	CASE
		WHEN a.`state` IN ('triage-admitted', 'prepare-admitted') AND a.`active_rank` > 1
		THEN 'manual-review'
		WHEN a.`state` IN ('blocked', 'failed') AND a.`next_attempt_at` IS NOT NULL
		THEN 'manual-review'
		ELSE a.`state`
	END,
	a.`priority`,
	CASE
		WHEN a.`state` IN ('triage-admitted', 'prepare-admitted') AND a.`active_rank` > 1
		THEN NULL
		WHEN a.`state` IN ('blocked', 'failed') AND a.`next_attempt_at` IS NOT NULL
		THEN NULL
		ELSE a.`current_workflow`
	END,
	CASE
		WHEN a.`state` IN ('triage-admitted', 'prepare-admitted') AND a.`active_rank` > 1
		THEN NULL
		WHEN a.`state` IN ('blocked', 'failed') AND a.`next_attempt_at` IS NOT NULL
		THEN NULL
		ELSE a.`current_run_id`
	END,
	CASE
		WHEN a.`state` IN ('triage-admitted', 'prepare-admitted') AND a.`active_rank` = 1
		THEN 'autopilot-attempt:migrated:' || a.`id`
		ELSE NULL
	END,
	a.`worktree_id`, a.`prepared_diff_id`, 1, a.`attempt_count`,
	CASE
		WHEN a.`state` IN ('blocked', 'failed') AND a.`next_attempt_at` IS NOT NULL
		THEN NULL
		ELSE a.`next_attempt_at`
	END,
	CASE
		WHEN a.`state` IN ('triage-admitted', 'prepare-admitted') AND a.`active_rank` > 1
		THEN 'Migration found a newer active admission for this PR owner.'
		WHEN a.`state` IN ('blocked', 'failed') AND a.`next_attempt_at` IS NOT NULL
		THEN 'Migration cannot prove that the legacy retry is safe.'
		ELSE a.`last_error`
	END,
	CASE
		WHEN a.`state` IN ('triage-admitted', 'prepare-admitted') AND a.`active_rank` > 1
		THEN json_object(
			'stage', CASE WHEN a.`state` = 'triage-admitted' THEN 'triage' ELSE 'prepare-worktree' END,
			'result', 'blocked', 'errorCode', 'migration-active-owner-conflict',
			'message', 'Migration found a newer active admission for this PR owner.'
		)
		WHEN a.`state` IN ('blocked', 'failed') AND a.`next_attempt_at` IS NOT NULL
		THEN json_object(
			'stage', CASE
				WHEN a.`current_workflow` = 'prepare-pr-worktree' THEN 'prepare-worktree'
				ELSE 'triage'
			END,
			'result', 'blocked', 'retryClass', 'uncertain',
			'errorCode', 'migration-legacy-retry-unproven',
			'message', 'Migration cannot prove that the legacy retry is safe.'
		)
		WHEN a.`state` = 'triaged' THEN json_object(
			'stage', 'triage', 'result', 'completed', 'shouldPrepare',
			COALESCE((
				SELECT json_extract(metadata.`value`, '$.shouldPrepare')
				FROM `app_metadata` AS metadata
				WHERE metadata.`key` = 'autopilot.admission.terminal:' || a.`current_run_id`
			), 0)
		)
		WHEN a.`state` = 'prepared' THEN json_object(
			'stage', 'prepare-worktree', 'result', 'completed', 'worktreeId', a.`worktree_id`
		)
		ELSE NULL
	END,
	CASE
		WHEN a.`state` IN ('triage-admitted', 'prepare-admitted') AND a.`active_rank` > 1
		THEN a.`updated_at`
		WHEN a.`state` IN ('blocked', 'failed') AND a.`next_attempt_at` IS NOT NULL
		THEN a.`updated_at`
		ELSE NULL
	END,
	a.`created_at`, a.`updated_at`
FROM ranked AS a;--> statement-breakpoint
DROP TABLE `autopilot_admissions`;--> statement-breakpoint
ALTER TABLE `__new_autopilot_admissions` RENAME TO `autopilot_admissions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
INSERT INTO `autopilot_stage_attempts` (
	`id`, `admission_id`, `owner_id`, `stage`, `attempt_number`, `workflow`,
	`run_id`, `event_sequence`, `status`, `input_fingerprint`, `artifact_json`,
	`created_at`, `started_at`
)
SELECT
	`current_stage_attempt_id`, `id`, `owner_id`,
	CASE WHEN `state` = 'triage-admitted' THEN 'triage' ELSE 'prepare-worktree' END,
	MAX(`attempt_count`, 1), `current_workflow`, `current_run_id`, `event_sequence`,
	CASE WHEN `current_run_id` IS NULL THEN 'reserved' ELSE 'running' END,
	'migrated:' || `event_fingerprint`, '{}', `updated_at`,
	CASE WHEN `current_run_id` IS NULL THEN NULL ELSE `updated_at` END
FROM `autopilot_admissions`
WHERE `current_stage_attempt_id` IS NOT NULL;--> statement-breakpoint
UPDATE `autopilot_pr_owners`
SET
	`status` = CASE
		WHEN EXISTS (
			SELECT 1 FROM `autopilot_stage_attempts` AS attempt
			WHERE attempt.`owner_id` = `autopilot_pr_owners`.`id`
				AND attempt.`status` IN ('reserved', 'running')
			) THEN 'active'
			ELSE `status`
		END,
	`worktree_id` = COALESCE((
		SELECT admission.`worktree_id`
		FROM `autopilot_admissions` AS admission
		WHERE admission.`owner_id` = `autopilot_pr_owners`.`id`
			AND admission.`worktree_id` IS NOT NULL
		ORDER BY admission.`event_sequence` DESC
		LIMIT 1
	), `worktree_id`),
	`last_dispatched_sequence` = COALESCE((
		SELECT MAX(admission.`event_sequence`)
		FROM `autopilot_admissions` AS admission
		WHERE admission.`owner_id` = `autopilot_pr_owners`.`id`
			AND (
				admission.`current_run_id` IS NOT NULL
				OR admission.`state` IN ('triaged', 'prepared')
			)
	), 0),
	`last_settled_sequence` = COALESCE((
		SELECT MAX(admission.`event_sequence`)
		FROM `autopilot_admissions` AS admission
		WHERE admission.`owner_id` = `autopilot_pr_owners`.`id`
			AND admission.`state` IN ('triaged', 'prepared')
	), 0);--> statement-breakpoint
INSERT INTO `autopilot_admission_events` (
	`admission_id`, `from_state`, `to_state`, `reason`, `workflow`, `run_id`,
	`data_json`, `created_at`
)
SELECT `id`, NULL, `state`, 'migration-backfill', `current_workflow`, `current_run_id`,
	json_object('ownerId', `owner_id`, 'eventSequence', `event_sequence`), `updated_at`
FROM `autopilot_admissions`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_admissions_watch_event` ON `autopilot_admissions` (`watch_id`,`event_fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_autopilot_admissions_state_due` ON `autopilot_admissions` (`state`,`next_attempt_at`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_autopilot_admissions_repo_pr` ON `autopilot_admissions` (`repo_id`,`pr_number`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_admissions_owner_sequence` ON `autopilot_admissions` (`owner_id`,`event_sequence`);--> statement-breakpoint
CREATE INDEX `idx_autopilot_admissions_owner_state` ON `autopilot_admissions` (`owner_id`,`state`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_autopilot_admission_events_admission` ON `autopilot_admission_events` (`admission_id`,"created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX `idx_autopilot_admission_events_run` ON `autopilot_admission_events` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_pr_owners_watch` ON `autopilot_pr_owners` (`watch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_pr_owners_flue_instance` ON `autopilot_pr_owners` (`flue_instance_id`) WHERE "autopilot_pr_owners"."flue_instance_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_autopilot_pr_owners_repo_pr` ON `autopilot_pr_owners` (`repo_id`,`pr_number`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_stage_attempts_number` ON `autopilot_stage_attempts` (`admission_id`,`stage`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_stage_attempts_run` ON `autopilot_stage_attempts` (`run_id`) WHERE "autopilot_stage_attempts"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_stage_attempts_dispatch` ON `autopilot_stage_attempts` (`dispatch_id`) WHERE "autopilot_stage_attempts"."dispatch_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_stage_attempts_owner_active` ON `autopilot_stage_attempts` (`owner_id`) WHERE "autopilot_stage_attempts"."status" IN ('reserved', 'running');--> statement-breakpoint
CREATE INDEX `idx_autopilot_stage_attempts_admission` ON `autopilot_stage_attempts` (`admission_id`,`stage`,"attempt_number" DESC);--> statement-breakpoint
CREATE INDEX `idx_autopilot_stage_attempts_status` ON `autopilot_stage_attempts` (`status`,`created_at`);
