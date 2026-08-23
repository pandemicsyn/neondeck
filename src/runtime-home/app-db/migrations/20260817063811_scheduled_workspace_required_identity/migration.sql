PRAGMA foreign_keys=OFF;--> statement-breakpoint
UPDATE `task_workspaces`
SET `provider_error` = COALESCE(
      `provider_error`,
      'Legacy workspace identity was recovered without a reusable provider credential binding; inspect or detach it manually.'
    ),
    `status` = 'failed',
    `lock_owner` = NULL,
    `lock_expires_at` = NULL,
    `collection_owner` = NULL,
    `collection_expires_at` = NULL
WHERE `provider_snapshot_json` IS NULL AND `provider_id` <> 'local';--> statement-breakpoint
UPDATE `task_workspaces`
SET `resource_metadata_json` = json_set(
      `resource_metadata_json`,
      '$.host', COALESCE(json_extract(`resource_metadata_json`, '$.host'), 'legacy.invalid'),
      '$.username', COALESCE(json_extract(`resource_metadata_json`, '$.username'), 'user'),
      '$.providerRoot', COALESCE(json_extract(`resource_metadata_json`, '$.providerRoot'), '/neondeck-legacy-unavailable'),
      '$.privateHome', COALESCE(json_extract(`resource_metadata_json`, '$.privateHome'), '/neondeck-legacy-unavailable/home'),
      '$.managedInfrastructure', COALESCE(json_extract(`resource_metadata_json`, '$.managedInfrastructure'), json('false')),
      '$.pathsCanonical', COALESCE(json_extract(`resource_metadata_json`, '$.pathsCanonical'), json('false'))
    )
WHERE `provider_id` <> 'local'
  AND (`provider_snapshot_json` IS NULL OR `physical_resource_key` IS NULL);--> statement-breakpoint
UPDATE `task_workspaces`
SET `provider_snapshot_json` = json_object(
      'version', 1,
      'providerId', 'local',
      'driver', 'local'
    )
WHERE `provider_snapshot_json` IS NULL AND `provider_id` = 'local';--> statement-breakpoint
UPDATE `task_workspaces`
SET `provider_snapshot_json` = json_object(
      'version', 1,
      'providerId', `provider_id`,
      'driver', 'exe.dev',
      'config', json_object(
        'driver', 'exe.dev',
        'remoteRoot', json_extract(`resource_metadata_json`, '$.providerRoot'),
        'username', json_extract(`resource_metadata_json`, '$.username')
      )
    )
WHERE `provider_snapshot_json` IS NULL AND `provider_id` = 'exe.dev';--> statement-breakpoint
UPDATE `task_workspaces`
SET `provider_snapshot_json` = json_object(
      'version', 1,
      'providerId', `provider_id`,
      'driver', 'ssh',
      'config', json_object(
        'driver', 'ssh',
        'hostEnv', 'NEONDECK_LEGACY_WORKSPACE_PROVIDER_UNAVAILABLE',
        'username', json_extract(`resource_metadata_json`, '$.username'),
        'port', COALESCE(json_extract(`resource_metadata_json`, '$.port'), 22),
        'remoteRoot', json_extract(`resource_metadata_json`, '$.providerRoot')
      )
    )
WHERE `provider_snapshot_json` IS NULL AND `provider_id` <> 'local' AND `provider_id` <> 'exe.dev';--> statement-breakpoint
UPDATE `task_workspaces`
SET `physical_resource_key` = 'local:' || `workspace_root`
WHERE `physical_resource_key` IS NULL AND `provider_id` = 'local';--> statement-breakpoint
UPDATE `task_workspaces`
SET `physical_resource_key` = 'ssh://' ||
      json_extract(`resource_metadata_json`, '$.username') || '@' ||
      lower(json_extract(`resource_metadata_json`, '$.host')) || ':' ||
      COALESCE(json_extract(`resource_metadata_json`, '$.port'), 22) ||
      `workspace_root`
WHERE `physical_resource_key` IS NULL AND `provider_id` <> 'local';--> statement-breakpoint
CREATE TABLE `__new_task_workspaces` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`owning_run_id` text,
	`provider_id` text NOT NULL,
	`provider_resource_id` text NOT NULL,
	`provider_snapshot_json` text NOT NULL,
	`physical_resource_key` text NOT NULL,
	`resource_metadata_json` text NOT NULL,
	`lifecycle` text NOT NULL,
	`repo_id` text NOT NULL,
	`workspace_root` text NOT NULL,
	`requested_ref` text NOT NULL,
	`revision_mode` text NOT NULL,
	`git_mode` text NOT NULL,
	`branch_name` text,
	`base_sha` text,
	`initial_sha` text,
	`final_sha` text,
	`dirty` integer,
	`local_worktree_id` text,
	`authority` text NOT NULL,
	`retention` text NOT NULL,
	`status` text NOT NULL,
	`lock_owner` text,
	`lock_expires_at` text,
	`collection_owner` text,
	`collection_expires_at` text,
	`retention_reason` text,
	`provider_error` text,
	`created_at` text NOT NULL,
	`last_used_at` text NOT NULL,
	`retained_at` text,
	`cleanup_attempted_at` text,
	`deleted_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_task_workspaces`(`id`, `task_id`, `owning_run_id`, `provider_id`, `provider_resource_id`, `provider_snapshot_json`, `physical_resource_key`, `resource_metadata_json`, `lifecycle`, `repo_id`, `workspace_root`, `requested_ref`, `revision_mode`, `git_mode`, `branch_name`, `base_sha`, `initial_sha`, `final_sha`, `dirty`, `local_worktree_id`, `authority`, `retention`, `status`, `lock_owner`, `lock_expires_at`, `collection_owner`, `collection_expires_at`, `retention_reason`, `provider_error`, `created_at`, `last_used_at`, `retained_at`, `cleanup_attempted_at`, `deleted_at`, `updated_at`) SELECT `id`, `task_id`, `owning_run_id`, `provider_id`, `provider_resource_id`, `provider_snapshot_json`, `physical_resource_key`, `resource_metadata_json`, `lifecycle`, `repo_id`, `workspace_root`, `requested_ref`, `revision_mode`, `git_mode`, `branch_name`, `base_sha`, `initial_sha`, `final_sha`, `dirty`, `local_worktree_id`, `authority`, `retention`, `status`, `lock_owner`, `lock_expires_at`, `collection_owner`, `collection_expires_at`, `retention_reason`, `provider_error`, `created_at`, `last_used_at`, `retained_at`, `cleanup_attempted_at`, `deleted_at`, `updated_at` FROM `task_workspaces`;--> statement-breakpoint
DROP TABLE `task_workspaces`;--> statement-breakpoint
ALTER TABLE `__new_task_workspaces` RENAME TO `task_workspaces`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_task_workspaces_task` ON `task_workspaces` (`task_id`,`status`,"updated_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_workspaces_run` ON `task_workspaces` (`owning_run_id`) WHERE "task_workspaces"."owning_run_id" IS NOT NULL;
