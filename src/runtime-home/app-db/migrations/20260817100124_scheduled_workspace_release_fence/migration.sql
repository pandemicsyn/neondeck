ALTER TABLE `task_workspaces` ADD `release_fenced_at` text;
--> statement-breakpoint
UPDATE `scheduled_run_workspace_snapshots`
SET `snapshot_json` = json_set(
  `snapshot_json`,
  '$.releaseFencedAt',
  json('null')
)
WHERE json_type(`snapshot_json`, '$.releaseFencedAt') IS NULL;
