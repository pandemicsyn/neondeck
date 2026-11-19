-- Keep retired checkouts on disk and remove them from normal workspace operations.
UPDATE worktrees
SET lifecycle_status = 'archived',
    direct_push_allowed = 0,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE lifecycle_status <> 'deleted'
  AND (
    created_by = 'factory-delivery'
    OR owning_workflow_run_id GLOB 'factory-delivery:*'
    OR id IN (SELECT worktree_id FROM coding_runs WHERE worktree_id IS NOT NULL)
    OR owning_workflow_run_id IN (SELECT run_id FROM coding_runs)
    OR id IN (SELECT worktree_id FROM prepared_diffs WHERE created_by = 'factory')
  );
--> statement-breakpoint
UPDATE prepared_diff_approvals
SET status = 'superseded',
    reason = 'Software factory removed',
    resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'pending'
  AND prepared_diff_id IN (
    SELECT id FROM prepared_diffs
    WHERE created_by = 'factory'
      OR worktree_id IN (SELECT id FROM worktrees WHERE lifecycle_status = 'archived')
  );
--> statement-breakpoint
UPDATE prepared_diffs
SET status = 'abandoned',
    push_approval_status = 'rejected',
    abandoned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status NOT IN ('abandoned', 'pushed')
  AND (
    created_by = 'factory'
    OR worktree_id IN (SELECT id FROM worktrees WHERE lifecycle_status = 'archived')
  );
--> statement-breakpoint
-- Previously owned watches continue observing without inheriting coding authority.
UPDATE pr_watches AS watch
SET autopilot_mode = 'notify-only',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE autopilot_mode <> 'notify-only'
  AND (
    created_by = 'factory-delivery'
    OR EXISTS (
      SELECT 1 FROM factory_delivery_pipelines AS pipeline
      WHERE json_extract(pipeline.record_json, '$.coordinator.watchId') = watch.id
        OR (pipeline.pr_number = watch.pr_number AND (
          pipeline.repo_id = watch.repo_id
          OR (
            lower(json_extract(pipeline.record_json, '$.authorization.target.owner')) = lower(watch.github_owner)
            AND lower(json_extract(pipeline.record_json, '$.authorization.target.name')) = lower(watch.github_name)
          )
        ))
    )
  );
--> statement-breakpoint
DROP TABLE `coding_run_events`;--> statement-breakpoint
DROP TABLE `coding_runs`;--> statement-breakpoint
DROP TABLE `factory_audit`;--> statement-breakpoint
DROP TABLE `factory_delivery_pipelines`;--> statement-breakpoint
DROP TABLE `factory_diagnostics`;--> statement-breakpoint
DROP TABLE `factory_github_comments`;--> statement-breakpoint
DROP TABLE `factory_github_deliveries`;--> statement-breakpoint
DROP TABLE `factory_github_sync`;--> statement-breakpoint
DROP TABLE `factory_linear_records`;--> statement-breakpoint
DROP TABLE `factory_planning_bindings`;--> statement-breakpoint
DROP TABLE `factory_planning_effects`;--> statement-breakpoint
DROP TABLE `factory_planning_intents`;--> statement-breakpoint
DROP TABLE `factory_releases`;--> statement-breakpoint
DROP TABLE `factory_spec_revisions`;--> statement-breakpoint
DROP TABLE `factory_work_items`;--> statement-breakpoint
DROP TABLE `factory_sources`;--> statement-breakpoint
DROP TABLE `factory_worker_health`;--> statement-breakpoint
DROP TABLE `factory_writeback_records`;
