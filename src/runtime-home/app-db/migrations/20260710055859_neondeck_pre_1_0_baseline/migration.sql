CREATE TABLE `app_metadata` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `autopilot_admissions` (
	`id` text PRIMARY KEY,
	`watch_id` text NOT NULL,
	`event_fingerprint` text NOT NULL,
	`repo_id` text NOT NULL,
	`pr_number` integer NOT NULL,
	`mode` text NOT NULL,
	`input_json` text DEFAULT '{}' NOT NULL,
	`state` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`current_workflow` text,
	`current_run_id` text,
	`worktree_id` text,
	`prepared_diff_id` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_session_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`action` text NOT NULL,
	`session_id` text,
	`surface` text,
	`reason` text,
	`metadata_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_session_command_events` (
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
CREATE TABLE `chat_session_surfaces` (
	`surface` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_sessions` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`agent_name` text NOT NULL,
	`kind` text NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`archived_at` text,
	`linked_repo_id` text,
	`linked_watch_id` text,
	`linked_task_id` text,
	`stale_reasons_json` text,
	`ui_metadata_json` text,
	`summary` text,
	`summary_generated_at` text,
	`summary_source` text,
	`summary_refresh_note` text,
	`context_loaded_at` text,
	`context_memory_ids_json` text,
	`learning_turn_count` integer DEFAULT 0 NOT NULL,
	`last_learning_review_turn_count` integer DEFAULT 0 NOT NULL,
	`last_learning_review_at` text,
	`last_learning_curation_turn_count` integer DEFAULT 0 NOT NULL,
	`last_learning_curation_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_active_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `config_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`action` text NOT NULL,
	`file` text NOT NULL,
	`target` text,
	`before_json` text,
	`after_json` text,
	`changed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `execution_approvals` (
	`id` text PRIMARY KEY,
	`command` text NOT NULL,
	`backend` text NOT NULL,
	`cwd` text,
	`context` text NOT NULL,
	`risk` text NOT NULL,
	`policy_decision` text NOT NULL,
	`status` text NOT NULL,
	`approval_decision` text,
	`approver_surface` text,
	`session_id` text,
	`request_context_json` text,
	`result_json` text,
	`exit_code` integer,
	`stdout_preview` text,
	`stderr_preview` text,
	`error` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`used_at` text,
	`executed_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `github_pr_file_cache` (
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`payload` text NOT NULL,
	`byte_size` integer NOT NULL,
	`fetched_at` text NOT NULL,
	CONSTRAINT `github_pr_file_cache_pk` PRIMARY KEY(`repo`, `pr_number`, `head_sha`)
);
--> statement-breakpoint
CREATE TABLE `kilo_result_events` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`event_type` text NOT NULL,
	`summary` text NOT NULL,
	`data_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kilo_result_state` (
	`task_id` text PRIMARY KEY,
	`prepared_diff_id` text,
	`classification` text NOT NULL,
	`verification_status` text NOT NULL,
	`promotion_status` text NOT NULL,
	`diff_fingerprint` text,
	`verified_diff_fingerprint` text,
	`review_summary_json` text,
	`diff_summary_json` text,
	`policy_json` text,
	`verification_json` text,
	`promotion_json` text,
	`pending_approvals_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`reviewed_at` text,
	`verified_at` text,
	`promoted_at` text
);
--> statement-breakpoint
CREATE TABLE `kilo_session_audit` (
	`id` text PRIMARY KEY,
	`task_id` text,
	`session_id` text,
	`child_session_id` text,
	`read_type` text NOT NULL,
	`requester_surface` text NOT NULL,
	`reason` text,
	`limit_count` integer,
	`offset_count` integer,
	`include_full_transcript` integer DEFAULT 0 NOT NULL,
	`include_tool_output` integer DEFAULT 0 NOT NULL,
	`include_diff` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kilo_task_events` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`event_index` integer NOT NULL,
	`event_type` text NOT NULL,
	`stream` text NOT NULL,
	`session_id` text,
	`child_session_id` text,
	`summary` text NOT NULL,
	`data_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kilo_tasks` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`repo_id` text NOT NULL,
	`repo_full_name` text NOT NULL,
	`worktree_id` text,
	`lock_id` text,
	`cwd` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`explicit_user_request` integer NOT NULL,
	`auto_enabled` integer DEFAULT 0 NOT NULL,
	`cli_path` text NOT NULL,
	`args_json` text NOT NULL,
	`pid` integer,
	`process_started_at` text,
	`root_session_id` text,
	`child_session_ids_json` text DEFAULT '[]' NOT NULL,
	`raw_log_path` text,
	`summary` text,
	`exit_code` integer,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `learning_candidates` (
	`id` text PRIMARY KEY,
	`target` text NOT NULL,
	`status` text NOT NULL,
	`action` text,
	`scope` text,
	`key` text,
	`value_json` text,
	`skill_id` text,
	`patch_json` text,
	`repo_id` text,
	`reason` text,
	`review_id` text,
	`created_at` text NOT NULL,
	`decided_at` text
);
--> statement-breakpoint
CREATE TABLE `learning_events` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`source` text NOT NULL,
	`source_id` text,
	`repo_id` text,
	`session_id` text,
	`pr_key` text,
	`data_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `learning_reviews` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`model` text NOT NULL,
	`thinking_level` text NOT NULL,
	`trigger_json` text NOT NULL,
	`input_summary_json` text,
	`result_json` text,
	`error` text,
	`flue_run_id` text,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `mcp_oauth_logins` (
	`id` text PRIMARY KEY,
	`server_id` text NOT NULL,
	`server_identity` text,
	`state` text NOT NULL,
	`status` text NOT NULL,
	`redirect_url` text NOT NULL,
	`authorization_url` text,
	`discovery_state_json` text,
	`code_verifier` text,
	`error` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`completed_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_oauth_tokens` (
	`server_id` text PRIMARY KEY,
	`server_identity` text,
	`access_token` text,
	`refresh_token` text,
	`token_type` text,
	`id_token` text,
	`expires_at` text,
	`scopes_json` text,
	`client_information_json` text,
	`discovery_state_json` text,
	`code_verifier` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_tool_approvals` (
	`id` text PRIMARY KEY,
	`server_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`adapted_name` text NOT NULL,
	`arguments_hash` text NOT NULL,
	`arguments_preview` text NOT NULL,
	`status` text NOT NULL,
	`approver_surface` text,
	`session_id` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`used_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_tool_audit` (
	`id` text PRIMARY KEY,
	`server_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`adapted_name` text NOT NULL,
	`arguments_hash` text NOT NULL,
	`decision` text NOT NULL,
	`approval_id` text,
	`duration_ms` integer,
	`ok` integer NOT NULL,
	`result_preview` text,
	`error` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_tool_catalog` (
	`server_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`adapted_name` text NOT NULL,
	`description` text NOT NULL,
	`input_schema_json` text,
	`output_schema_json` text,
	`annotations_json` text,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `mcp_tool_catalog_pk` PRIMARY KEY(`server_id`, `tool_name`)
);
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`repo_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_events` (
	`id` text PRIMARY KEY,
	`memory_id` text,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text,
	`before_json` text,
	`after_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `neon_sessions` (
	`id` text PRIMARY KEY,
	`label` text NOT NULL,
	`agent_name` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`created_at` text NOT NULL,
	`activated_at` text NOT NULL,
	`ended_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY,
	`level` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`source` text,
	`source_id` text,
	`data_json` text,
	`read_at` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`updated_at` text,
	`occurrence_count` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pr_review_draft_comments` (
	`id` text PRIMARY KEY,
	`draft_id` text NOT NULL,
	`path` text NOT NULL,
	`side` text NOT NULL,
	`line` integer NOT NULL,
	`start_line` integer,
	`start_side` text,
	`body` text NOT NULL,
	`origin` text DEFAULT 'human' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_pr_review_draft_comments_draft_id_pr_review_drafts_id_fk` FOREIGN KEY (`draft_id`) REFERENCES `pr_review_drafts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `pr_review_drafts` (
	`id` text PRIMARY KEY,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`verdict` text,
	`body` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`submitted_at` text
);
--> statement-breakpoint
CREATE TABLE `pr_review_neon_seeded_comments` (
	`comment_id` text PRIMARY KEY,
	`draft_id` text NOT NULL,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`path` text NOT NULL,
	`side` text NOT NULL,
	`line` integer NOT NULL,
	`start_line` integer,
	`start_side` text,
	`severity` text NOT NULL,
	`summary` text NOT NULL,
	`source` text NOT NULL,
	`outcome` text,
	`outcome_at` text,
	`seeded_at` text NOT NULL,
	CONSTRAINT `fk_pr_review_neon_seeded_comments_draft_id_pr_review_drafts_id_fk` FOREIGN KEY (`draft_id`) REFERENCES `pr_review_drafts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `pr_watch_event_watermarks` (
	`watch_id` text NOT NULL,
	`category` text NOT NULL,
	`watermark_json` text NOT NULL,
	`source_updated_at` text,
	`checked_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `pr_watch_event_watermarks_pk` PRIMARY KEY(`watch_id`, `category`)
);
--> statement-breakpoint
CREATE TABLE `pr_watches` (
	`id` text PRIMARY KEY,
	`repo_id` text NOT NULL,
	`repo_full_name` text NOT NULL,
	`github_owner` text NOT NULL,
	`github_name` text NOT NULL,
	`pr_number` integer NOT NULL,
	`desired_terminal_state` text NOT NULL,
	`status` text NOT NULL,
	`pr_state` text,
	`title` text,
	`url` text,
	`merge_commit_sha` text,
	`last_snapshot_json` text,
	`last_outcome` text,
	`last_checked_at` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `pr_watches_repo_full_name_pr_number_unique` UNIQUE(`repo_full_name`,`pr_number`)
);
--> statement-breakpoint
CREATE TABLE `prepared_diff_approvals` (
	`id` text PRIMARY KEY,
	`prepared_diff_id` text NOT NULL,
	`worktree_id` text NOT NULL,
	`approval_type` text NOT NULL,
	`status` text NOT NULL,
	`target_sha` text,
	`policy_hash` text,
	`policy_decision` text,
	`reason` text,
	`approver_surface` text,
	`requested_at` text NOT NULL,
	`resolved_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prepared_diffs` (
	`id` text PRIMARY KEY,
	`worktree_id` text NOT NULL UNIQUE,
	`repo_id` text NOT NULL,
	`repo_full_name` text NOT NULL,
	`pr_number` integer,
	`title` text NOT NULL,
	`source_worktree_path` text NOT NULL,
	`base_ref` text NOT NULL,
	`head_ref` text NOT NULL,
	`head_sha` text,
	`status` text NOT NULL,
	`push_approval_status` text NOT NULL,
	`verification_status` text NOT NULL,
	`summary_json` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`abandoned_at` text
);
--> statement-breakpoint
CREATE TABLE `ref_watches` (
	`id` text PRIMARY KEY,
	`repo_id` text NOT NULL,
	`repo_full_name` text NOT NULL,
	`github_owner` text NOT NULL,
	`github_name` text NOT NULL,
	`ref` text NOT NULL,
	`status` text NOT NULL,
	`title` text,
	`url` text,
	`last_snapshot_json` text,
	`last_outcome` text,
	`last_checked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `ref_watches_repo_full_name_ref_unique` UNIQUE(`repo_full_name`,`ref`)
);
--> statement-breakpoint
CREATE TABLE `repo_edit_events` (
	`id` text PRIMARY KEY,
	`repo_id` text NOT NULL,
	`session_id` text,
	`workflow_run_id` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`paths_json` text NOT NULL,
	`input_hash` text,
	`diff_summary_json` text,
	`diff_patch` text,
	`error_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`worktree_id` text
);
--> statement-breakpoint
CREATE TABLE `repo_file_reads` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text,
	`repo_id` text NOT NULL,
	`worktree_id` text,
	`path` text NOT NULL,
	`mtime_ms` real NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`partial` integer DEFAULT 0 NOT NULL,
	`read_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`repo_id` text,
	`source_ref` text,
	`html_path` text NOT NULL,
	`summary_json` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scheduled_task_runs` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`status` text NOT NULL,
	`outcome` text NOT NULL,
	`message` text NOT NULL,
	`workflow_run_id` text,
	`session_id` text,
	`result_json` text,
	`error` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`trigger_json` text NOT NULL,
	`payload_json` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`next_run_at` text,
	`claim_id` text,
	`claim_expires_at` text,
	`last_run_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`run_id` text,
	`workflow` text,
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
CREATE TABLE `workflow_run_observations` (
	`run_id` text PRIMARY KEY,
	`workflow` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`last_event_at` text NOT NULL,
	`last_message` text NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`is_error` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_summaries` (
	`id` text PRIMARY KEY,
	`workflow` text NOT NULL,
	`run_id` text,
	`status` text NOT NULL,
	`summary_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worktree_cleanup_attempts` (
	`id` text PRIMARY KEY,
	`worktree_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text NOT NULL,
	`error` text,
	`deleted` integer DEFAULT 0 NOT NULL,
	`attempted_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worktree_events` (
	`id` text PRIMARY KEY,
	`worktree_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`event_type` text NOT NULL,
	`status` text NOT NULL,
	`message` text NOT NULL,
	`data_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worktree_locks` (
	`id` text PRIMARY KEY,
	`scope` text NOT NULL,
	`scope_key` text NOT NULL,
	`worktree_id` text,
	`repo_id` text NOT NULL,
	`pr_number` integer,
	`owner` text NOT NULL,
	`workflow_run_id` text,
	`expires_at` text NOT NULL,
	`released_at` text,
	`stale_recovered_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY,
	`repo_id` text NOT NULL,
	`repo_full_name` text NOT NULL,
	`github_owner` text NOT NULL,
	`github_name` text NOT NULL,
	`pr_number` integer,
	`base_ref` text NOT NULL,
	`head_owner` text,
	`head_name` text,
	`head_ref` text NOT NULL,
	`head_sha` text,
	`local_path` text NOT NULL UNIQUE,
	`storage_kind` text NOT NULL,
	`owning_workflow_run_id` text,
	`lifecycle_status` text NOT NULL,
	`last_synced_sha` text,
	`last_pushed_sha` text,
	`cleanup_policy_json` text,
	`direct_push_allowed` integer DEFAULT 0 NOT NULL,
	`adopted` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_autopilot_admissions_watch_event` ON `autopilot_admissions` (`watch_id`,`event_fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_autopilot_admissions_state_due` ON `autopilot_admissions` (`state`,`next_attempt_at`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_autopilot_admissions_repo_pr` ON `autopilot_admissions` (`repo_id`,`pr_number`,`state`);--> statement-breakpoint
CREATE INDEX `idx_chat_session_audit_session` ON `chat_session_audit` (`session_id`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_chat_session_command_events_session` ON `chat_session_command_events` (`session_id`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_chat_sessions_recent` ON `chat_sessions` (`archived_at`,"pinned" DESC,"last_active_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_chat_sessions_kind` ON `chat_sessions` (`kind`,`archived_at`,"last_active_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_execution_approvals_status` ON `execution_approvals` (`status`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_execution_approvals_updated` ON `execution_approvals` ("updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_kilo_result_events_task` ON `kilo_result_events` (`task_id`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_kilo_result_state_updated` ON `kilo_result_state` ("updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_kilo_session_audit_session` ON `kilo_session_audit` (`session_id`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_kilo_task_events_task` ON `kilo_task_events` (`task_id`,`event_index`);--> statement-breakpoint
CREATE INDEX `idx_kilo_tasks_status` ON `kilo_tasks` (`status`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_kilo_tasks_repo` ON `kilo_tasks` (`repo_id`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_kilo_tasks_session` ON `kilo_tasks` (`root_session_id`);--> statement-breakpoint
CREATE INDEX `idx_learning_candidates_status` ON `learning_candidates` (`target`,`status`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_learning_events_type` ON `learning_events` (`type`,"created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_learning_pr_handled_source` ON `learning_events` (`source_id`) WHERE "learning_events"."type" = 'pr_handled' AND "learning_events"."source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_learning_reviews_kind` ON `learning_reviews` (`kind`,`status`,"started_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_approvals_pending` ON `mcp_tool_approvals` (`server_id`,`tool_name`,`adapted_name`,`arguments_hash`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_audit_created` ON `mcp_tool_audit` ("created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_mcp_tool_catalog_status` ON `mcp_tool_catalog` (`server_id`,`status`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_memories_active_scope` ON `memories` (`status`,`scope`,"updated_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_memories_scope_key_repo` ON `memories` (`scope`,`key`,COALESCE("repo_id", ''));--> statement-breakpoint
CREATE INDEX `idx_memory_events_changed` ON `memory_events` ("created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_notifications_source_unresolved` ON `notifications` (`source`,`source_id`,`resolved_at`);--> statement-breakpoint
CREATE INDEX `idx_notifications_attention` ON `notifications` (`resolved_at`,`read_at`,`level`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_pr_review_draft_comments_draft` ON `pr_review_draft_comments` (`draft_id`,"created_at" ASC);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pr_review_drafts_live` ON `pr_review_drafts` (`repo`,`pr_number`) WHERE "pr_review_drafts"."status" = 'draft';--> statement-breakpoint
CREATE INDEX `idx_pr_review_drafts_pr` ON `pr_review_drafts` (`repo`,`pr_number`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_pr_review_neon_seeded_comments_draft` ON `pr_review_neon_seeded_comments` (`draft_id`,"seeded_at" ASC);--> statement-breakpoint
CREATE INDEX `idx_pr_review_neon_seeded_comments_pr` ON `pr_review_neon_seeded_comments` (`repo`,`pr_number`,"seeded_at" ASC);--> statement-breakpoint
CREATE INDEX `idx_pr_watch_event_watermarks_watch` ON `pr_watch_event_watermarks` (`watch_id`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_prepared_diff_approvals_pending` ON `prepared_diff_approvals` (`status`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_prepared_diff_approvals_diff` ON `prepared_diff_approvals` (`prepared_diff_id`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_prepared_diffs_status` ON `prepared_diffs` (`status`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_prepared_diffs_repo` ON `prepared_diffs` (`repo_id`,`pr_number`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_repo_edit_events_updated` ON `repo_edit_events` ("updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_repo_edit_events_repo` ON `repo_edit_events` (`repo_id`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_repo_file_reads_lookup` ON `repo_file_reads` (`session_id`,`repo_id`,`worktree_id`,`path`,"read_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_reports_kind_created` ON `reports` (`kind`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_reports_repo_created` ON `reports` (`repo_id`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_scheduled_task_runs_task` ON `scheduled_task_runs` (`task_id`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_scheduled_task_runs_status` ON `scheduled_task_runs` (`status`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_due` ON `scheduled_tasks` (`enabled`,`next_run_at`,`claim_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_kind` ON `scheduled_tasks` (`kind`,`enabled`);--> statement-breakpoint
CREATE INDEX `idx_workflow_events_run` ON `workflow_events` (`run_id`,`event_index`);--> statement-breakpoint
CREATE INDEX `idx_workflow_events_created` ON `workflow_events` ("created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_worktree_cleanup_attempts_worktree` ON `worktree_cleanup_attempts` (`worktree_id`,"attempted_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_worktree_events_worktree` ON `worktree_events` (`worktree_id`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_worktree_locks_active` ON `worktree_locks` (`scope_key`,`released_at`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_worktree_locks_one_active` ON `worktree_locks` (`scope_key`) WHERE "worktree_locks"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_worktrees_repo` ON `worktrees` (`repo_id`,`lifecycle_status`,"updated_at" DESC);--> statement-breakpoint
CREATE INDEX `idx_worktrees_pr` ON `worktrees` (`repo_id`,`pr_number`,`head_ref`,`lifecycle_status`);