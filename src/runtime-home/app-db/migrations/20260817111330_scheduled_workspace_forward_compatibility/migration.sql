DROP INDEX IF EXISTS `idx_task_workspaces_lock`;
--> statement-breakpoint
UPDATE `task_workspaces`
SET `provider_snapshot_json` = json_set(
  `provider_snapshot_json`,
  '$.config.privateKeyEnv',
  'NEONDECK_LEGACY_WORKSPACE_PRIVATE_KEY_UNAVAILABLE'
)
WHERE json_extract(`provider_snapshot_json`, '$.driver') = 'ssh'
  AND json_type(`provider_snapshot_json`, '$.config.privateKeyEnv') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.resourceMetadata',
  json('{}')
)
WHERE json_type(`snapshot_json`, '$.resourceMetadata') <> 'object'
   OR json_type(`snapshot_json`, '$.resourceMetadata') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.resourceMetadata.privateHome',
  '/neondeck-legacy-unavailable/workspace-home'
)
WHERE json_extract(`snapshot_json`, '$.providerId') = 'local'
  AND json_type(`snapshot_json`, '$.resourceMetadata.privateHome') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.resourceMetadata.host',
  'legacy.invalid'
)
WHERE json_extract(`snapshot_json`, '$.providerId') <> 'local'
  AND json_type(`snapshot_json`, '$.resourceMetadata.host') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.resourceMetadata.username',
  'user'
)
WHERE json_extract(`snapshot_json`, '$.providerId') <> 'local'
  AND json_type(`snapshot_json`, '$.resourceMetadata.username') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.resourceMetadata.providerRoot',
  '/neondeck-legacy-unavailable'
)
WHERE json_extract(`snapshot_json`, '$.providerId') <> 'local'
  AND json_type(`snapshot_json`, '$.resourceMetadata.providerRoot') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.resourceMetadata.privateHome',
  '/neondeck-legacy-unavailable/home'
)
WHERE json_extract(`snapshot_json`, '$.providerId') <> 'local'
  AND json_type(`snapshot_json`, '$.resourceMetadata.privateHome') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.resourceMetadata.managedInfrastructure',
  json('false')
)
WHERE json_extract(`snapshot_json`, '$.providerId') <> 'local'
  AND json_type(`snapshot_json`, '$.resourceMetadata.managedInfrastructure') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.resourceMetadata.pathsCanonical',
  json('false')
)
WHERE json_extract(`snapshot_json`, '$.providerId') <> 'local'
  AND json_type(`snapshot_json`, '$.resourceMetadata.pathsCanonical') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.providerSnapshot',
  json_object(
    'version', 1,
    'providerId', 'local',
    'driver', 'local'
  )
)
WHERE json_extract(`snapshot_json`, '$.providerId') = 'local'
  AND json_type(`snapshot_json`, '$.providerSnapshot') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.providerSnapshot',
  json_object(
    'version', 1,
    'providerId', json_extract(`snapshot_json`, '$.providerId'),
    'driver', 'exe.dev',
    'config', json_object(
      'driver', 'exe.dev',
      'remoteRoot', json_extract(`snapshot_json`, '$.resourceMetadata.providerRoot'),
      'username', json_extract(`snapshot_json`, '$.resourceMetadata.username')
    )
  )
)
WHERE json_extract(`snapshot_json`, '$.providerId') = 'exe.dev'
  AND json_type(`snapshot_json`, '$.providerSnapshot') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.providerSnapshot',
  json_object(
    'version', 1,
    'providerId', json_extract(`snapshot_json`, '$.providerId'),
    'driver', 'ssh',
    'config', json_object(
      'driver', 'ssh',
      'hostEnv', 'NEONDECK_LEGACY_WORKSPACE_PROVIDER_UNAVAILABLE',
      'privateKeyEnv', 'NEONDECK_LEGACY_WORKSPACE_PRIVATE_KEY_UNAVAILABLE',
      'username', json_extract(`snapshot_json`, '$.resourceMetadata.username'),
      'port', COALESCE(json_extract(`snapshot_json`, '$.resourceMetadata.port'), 22),
      'remoteRoot', json_extract(`snapshot_json`, '$.resourceMetadata.providerRoot')
    )
  )
)
WHERE json_extract(`snapshot_json`, '$.providerId') <> 'local'
  AND json_extract(`snapshot_json`, '$.providerId') <> 'exe.dev'
  AND json_type(`snapshot_json`, '$.providerSnapshot') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.providerSnapshot.config.privateKeyEnv',
  'NEONDECK_LEGACY_WORKSPACE_PRIVATE_KEY_UNAVAILABLE'
)
WHERE json_extract(`snapshot_json`, '$.providerSnapshot.driver') = 'ssh'
  AND json_type(`snapshot_json`, '$.providerSnapshot.config.privateKeyEnv') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.physicalResourceKey',
  'local:' || COALESCE(json_extract(`snapshot_json`, '$.workspaceRoot'), '/legacy-unavailable')
)
WHERE json_extract(`snapshot_json`, '$.providerId') = 'local'
  AND json_type(`snapshot_json`, '$.physicalResourceKey') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.physicalResourceKey',
  'ssh://' ||
    json_extract(`snapshot_json`, '$.resourceMetadata.username') || '@' ||
    lower(json_extract(`snapshot_json`, '$.resourceMetadata.host')) || ':' ||
    COALESCE(json_extract(`snapshot_json`, '$.resourceMetadata.port'), 22) ||
    json_extract(`snapshot_json`, '$.workspaceRoot')
)
WHERE json_extract(`snapshot_json`, '$.providerId') <> 'local'
  AND json_type(`snapshot_json`, '$.physicalResourceKey') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.collectionOwner',
  json('null')
)
WHERE json_type(`snapshot_json`, '$.collectionOwner') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.collectionExpiresAt',
  json('null')
)
WHERE json_type(`snapshot_json`, '$.collectionExpiresAt') IS NULL;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.repoSnapshot',
  json_object(
    'verified', json('false'),
    'id', json_extract(`snapshot_json`, '$.repoId'),
    'github', json_object(
      'owner', 'legacy-unavailable',
      'name', 'legacy-unavailable'
    ),
    'path', CASE
      WHEN json_extract(`snapshot_json`, '$.workspaceRoot') LIKE '/%'
        AND json_extract(`snapshot_json`, '$.workspaceRoot') <> '/'
        THEN json_extract(`snapshot_json`, '$.workspaceRoot')
      ELSE '/legacy-unavailable'
    END,
    'defaultBranch', json_extract(`snapshot_json`, '$.requestedRef')
  )
)
WHERE json_type(`snapshot_json`, '$.repoSnapshot') IS NULL;
--> statement-breakpoint
UPDATE `app_metadata` AS `lease`
SET `value` = json_set(
  `lease`.`value`,
  '$.providerId',
  COALESCE(
    (
      SELECT `backend`
      FROM `execution_approvals`
      WHERE 'approved-execution:' || `execution_approvals`.`id` = json_extract(`lease`.`value`, '$.owner')
      LIMIT 1
    ),
    (
      SELECT `provider_id`
      FROM `task_workspaces`
      WHERE `task_workspaces`.`physical_resource_key` = json_extract(`lease`.`value`, '$.physicalResourceKey')
        AND `task_workspaces`.`lock_owner` = json_extract(`lease`.`value`, '$.owner')
      ORDER BY `task_workspaces`.`updated_at` DESC
      LIMIT 1
    ),
    (
      SELECT `provider_id`
      FROM `task_workspaces`
      WHERE `task_workspaces`.`physical_resource_key` = json_extract(`lease`.`value`, '$.physicalResourceKey')
      ORDER BY `task_workspaces`.`updated_at` DESC
      LIMIT 1
    ),
    CASE
      WHEN json_extract(`lease`.`value`, '$.physicalResourceKey') LIKE 'local:%' THEN 'local'
      ELSE 'unknown-legacy-provider'
    END
  )
)
WHERE `key` LIKE 'workspace-resource-lease:%'
  AND json_type(`lease`.`value`, '$.providerId') IS NULL;
