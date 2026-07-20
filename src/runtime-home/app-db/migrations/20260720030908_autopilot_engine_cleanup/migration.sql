DROP INDEX IF EXISTS `idx_autopilot_admission_events_admission`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_admission_events_run`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_admissions_watch_event`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_admissions_state_due`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_admissions_repo_pr`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_admissions_owner_sequence`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_admissions_owner_state`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_owner_fix_attempt`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_owner_fix_token`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_owner_fix_owner`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_owner_generations_number`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_owner_generations_instance`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_owner_generations_owner`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_grounding_attempt`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_grounding_dispatch`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_grounding_owner`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_pr_owners_watch`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_pr_owners_flue_instance`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_pr_owners_repo_pr`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_stage_attempts_number`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_stage_attempts_run`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_stage_attempts_dispatch`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_stage_attempts_owner_active`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_stage_attempts_admission`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_autopilot_stage_attempts_status`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_pr_watch_event_intakes_one_pending`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_pr_watch_event_intakes_sequence`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_pr_watch_event_intakes_pending`;--> statement-breakpoint
DROP TABLE `autopilot_admission_events`;--> statement-breakpoint
DROP TABLE `autopilot_owner_fix_submissions`;--> statement-breakpoint
DROP TABLE `autopilot_owner_generations`;--> statement-breakpoint
DROP TABLE `autopilot_owner_grounding_snapshots`;--> statement-breakpoint
DROP TABLE `autopilot_pr_owners`;--> statement-breakpoint
DROP TABLE `autopilot_stage_attempts`;--> statement-breakpoint
DROP TABLE `autopilot_admissions`;--> statement-breakpoint
DROP TABLE `pr_watch_event_intakes`;--> statement-breakpoint
ALTER TABLE `pr_watches` DROP COLUMN `event_generation_id`;
