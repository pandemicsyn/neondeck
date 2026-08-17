ALTER TABLE `task_workspaces` ADD `repo_snapshot_json` text NOT NULL DEFAULT '{"verified":false,"id":"legacy","github":{"owner":"legacy-unavailable","name":"legacy-unavailable"},"path":"/legacy-unavailable","defaultBranch":"legacy-unavailable"}';
--> statement-breakpoint
UPDATE `task_workspaces`
SET `repo_snapshot_json` = json_object(
  'verified', json('false'),
  'id', `repo_id`,
  'github', json_object(
    'owner', 'legacy-unavailable',
    'name', 'legacy-unavailable'
  ),
  'path', CASE
    WHEN `workspace_root` LIKE '/%' AND `workspace_root` <> '/'
      THEN `workspace_root`
    ELSE '/legacy-unavailable'
  END,
  'defaultBranch', `requested_ref`
);
