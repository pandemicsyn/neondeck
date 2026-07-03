export const appDatabaseSchemaSql = `
      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        file TEXT NOT NULL,
        target TEXT,
        before_json TEXT,
        after_json TEXT,
        changed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pr_watches (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        repo_full_name TEXT NOT NULL,
        github_owner TEXT NOT NULL,
        github_name TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        desired_terminal_state TEXT NOT NULL,
        status TEXT NOT NULL,
        pr_state TEXT,
        title TEXT,
        url TEXT,
        merge_commit_sha TEXT,
        last_snapshot_json TEXT,
        last_outcome TEXT,
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo_full_name, pr_number)
      );

      CREATE TABLE IF NOT EXISTS ref_watches (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        repo_full_name TEXT NOT NULL,
        github_owner TEXT NOT NULL,
        github_name TEXT NOT NULL,
        ref TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT,
        url TEXT,
        last_snapshot_json TEXT,
        last_outcome TEXT,
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo_full_name, ref)
      );

      CREATE TABLE IF NOT EXISTS pr_watch_event_watermarks (
        watch_id TEXT NOT NULL,
        category TEXT NOT NULL,
        watermark_json TEXT NOT NULL,
        source_updated_at TEXT,
        checked_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(watch_id, category)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        blueprint TEXT,
        enabled INTEGER NOT NULL,
        interval_seconds INTEGER NOT NULL,
        config_json TEXT,
        next_run_at TEXT,
        last_run_at TEXT,
        last_outcome TEXT,
        last_message TEXT,
        last_result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        source TEXT,
        source_id TEXT,
        data_json TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        repo_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT,
        before_json TEXT,
        after_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS learning_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT,
        repo_id TEXT,
        session_id TEXT,
        pr_key TEXT,
        data_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS learning_reviews (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        thinking_level TEXT NOT NULL,
        trigger_json TEXT NOT NULL,
        input_summary_json TEXT,
        result_json TEXT,
        error TEXT,
        flue_run_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS learning_candidates (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        status TEXT NOT NULL,
        action TEXT,
        scope TEXT,
        key TEXT,
        value_json TEXT,
        skill_id TEXT,
        patch_json TEXT,
        repo_id TEXT,
        reason TEXT,
        review_id TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE IF NOT EXISTS workflow_summaries (
        id TEXT PRIMARY KEY,
        workflow TEXT NOT NULL,
        run_id TEXT,
        status TEXT NOT NULL,
        summary_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        workflow TEXT,
        event_type TEXT NOT NULL,
        event_index INTEGER,
        level TEXT,
        message TEXT NOT NULL,
        name TEXT,
        operation_kind TEXT,
        operation_id TEXT,
        duration_ms INTEGER,
        is_error INTEGER NOT NULL DEFAULT 0,
        summary_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_events_run
        ON workflow_events(run_id, event_index);

      CREATE INDEX IF NOT EXISTS idx_workflow_events_created
        ON workflow_events(created_at DESC);

      CREATE TABLE IF NOT EXISTS workflow_run_observations (
        run_id TEXT PRIMARY KEY,
        workflow TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        last_event_at TEXT NOT NULL,
        last_message TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        is_error INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS neon_sessions (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        activated_at TEXT NOT NULL,
        ended_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        linked_repo_id TEXT,
        linked_watch_id TEXT,
        linked_task_id TEXT,
        stale_reasons_json TEXT,
        ui_metadata_json TEXT,
        summary TEXT,
        summary_generated_at TEXT,
        summary_source TEXT,
        summary_refresh_note TEXT,
        context_loaded_at TEXT,
        context_memory_ids_json TEXT,
        learning_turn_count INTEGER NOT NULL DEFAULT 0,
        last_learning_review_turn_count INTEGER NOT NULL DEFAULT 0,
        last_learning_review_at TEXT,
        last_learning_curation_turn_count INTEGER NOT NULL DEFAULT 0,
        last_learning_curation_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_session_surfaces (
        surface TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_session_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        session_id TEXT,
        surface TEXT,
        reason TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS execution_approvals (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        backend TEXT NOT NULL,
        cwd TEXT,
        context TEXT NOT NULL,
        risk TEXT NOT NULL,
        policy_decision TEXT NOT NULL,
        status TEXT NOT NULL,
        approval_decision TEXT,
        approver_surface TEXT,
        session_id TEXT,
        request_context_json TEXT,
        result_json TEXT,
        exit_code INTEGER,
        stdout_preview TEXT,
        stderr_preview TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        executed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repo_edit_events (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        session_id TEXT,
        workflow_run_id TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        paths_json TEXT NOT NULL,
        input_hash TEXT,
        diff_summary_json TEXT,
        diff_patch TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repo_file_reads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        repo_id TEXT NOT NULL,
        worktree_id TEXT,
        path TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        partial INTEGER NOT NULL DEFAULT 0,
        read_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worktrees (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        repo_full_name TEXT NOT NULL,
        github_owner TEXT NOT NULL,
        github_name TEXT NOT NULL,
        pr_number INTEGER,
        base_ref TEXT NOT NULL,
        head_owner TEXT,
        head_name TEXT,
        head_ref TEXT NOT NULL,
        head_sha TEXT,
        local_path TEXT NOT NULL UNIQUE,
        storage_kind TEXT NOT NULL,
        owning_workflow_run_id TEXT,
        lifecycle_status TEXT NOT NULL,
        last_synced_sha TEXT,
        last_pushed_sha TEXT,
        cleanup_policy_json TEXT,
        direct_push_allowed INTEGER NOT NULL DEFAULT 0,
        adopted INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worktree_locks (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        worktree_id TEXT,
        repo_id TEXT NOT NULL,
        pr_number INTEGER,
        owner TEXT NOT NULL,
        workflow_run_id TEXT,
        expires_at TEXT NOT NULL,
        released_at TEXT,
        stale_recovered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worktree_events (
        id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worktree_cleanup_attempts (
        id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        error TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        attempted_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prepared_diffs (
        id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL UNIQUE,
        repo_id TEXT NOT NULL,
        repo_full_name TEXT NOT NULL,
        pr_number INTEGER,
        title TEXT NOT NULL,
        source_worktree_path TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        head_ref TEXT NOT NULL,
        head_sha TEXT,
        status TEXT NOT NULL,
        push_approval_status TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        summary_json TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        abandoned_at TEXT
      );

      CREATE TABLE IF NOT EXISTS prepared_diff_approvals (
        id TEXT PRIMARY KEY,
        prepared_diff_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        approval_type TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        approver_surface TEXT,
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kilo_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        repo_full_name TEXT NOT NULL,
        worktree_id TEXT,
        lock_id TEXT,
        cwd TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        explicit_user_request INTEGER NOT NULL,
        auto_enabled INTEGER NOT NULL DEFAULT 0,
        cli_path TEXT NOT NULL,
        args_json TEXT NOT NULL,
        pid INTEGER,
        process_started_at TEXT,
        root_session_id TEXT,
        child_session_ids_json TEXT NOT NULL DEFAULT '[]',
        raw_log_path TEXT,
        summary TEXT,
        exit_code INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS kilo_task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        event_index INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        stream TEXT NOT NULL,
        session_id TEXT,
        child_session_id TEXT,
        summary TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kilo_session_audit (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        session_id TEXT,
        child_session_id TEXT,
        read_type TEXT NOT NULL,
        requester_surface TEXT NOT NULL,
        reason TEXT,
        limit_count INTEGER,
        offset_count INTEGER,
        include_full_transcript INTEGER NOT NULL DEFAULT 0,
        include_tool_output INTEGER NOT NULL DEFAULT 0,
        include_diff INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kilo_result_state (
        task_id TEXT PRIMARY KEY,
        prepared_diff_id TEXT,
        classification TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        promotion_status TEXT NOT NULL,
        diff_fingerprint TEXT,
        verified_diff_fingerprint TEXT,
        review_summary_json TEXT,
        diff_summary_json TEXT,
        policy_json TEXT,
        verification_json TEXT,
        promotion_json TEXT,
        pending_approvals_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        reviewed_at TEXT,
        verified_at TEXT,
        promoted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS kilo_result_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL
      );
`;

export const appDatabaseIndexSql = `
      CREATE INDEX IF NOT EXISTS idx_notifications_source_unresolved
        ON notifications(source, source_id, resolved_at);

      CREATE INDEX IF NOT EXISTS idx_pr_watch_event_watermarks_watch
        ON pr_watch_event_watermarks(watch_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_notifications_attention
        ON notifications(resolved_at, read_at, level, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_memory_events_changed
        ON memory_events(created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_memories_active_scope
        ON memories(status, scope, updated_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_scope_key_repo
        ON memories(scope, key, COALESCE(repo_id, ''));

      CREATE INDEX IF NOT EXISTS idx_learning_events_type
        ON learning_events(type, created_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_pr_handled_source
        ON learning_events(source_id)
        WHERE type = 'pr_handled' AND source_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_learning_reviews_kind
        ON learning_reviews(kind, status, started_at DESC);

      CREATE INDEX IF NOT EXISTS idx_learning_candidates_status
        ON learning_candidates(target, status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_execution_approvals_status
        ON execution_approvals(status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_execution_approvals_updated
        ON execution_approvals(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_repo_edit_events_updated
        ON repo_edit_events(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_repo_edit_events_repo
        ON repo_edit_events(repo_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_repo_file_reads_lookup
        ON repo_file_reads(session_id, repo_id, worktree_id, path, read_at DESC);

      CREATE INDEX IF NOT EXISTS idx_chat_sessions_recent
        ON chat_sessions(archived_at, pinned DESC, last_active_at DESC);

      CREATE INDEX IF NOT EXISTS idx_chat_sessions_kind
        ON chat_sessions(kind, archived_at, last_active_at DESC);

      CREATE INDEX IF NOT EXISTS idx_chat_session_audit_session
        ON chat_session_audit(session_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_worktrees_repo
        ON worktrees(repo_id, lifecycle_status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_worktrees_pr
        ON worktrees(repo_id, pr_number, head_ref, lifecycle_status);

      CREATE INDEX IF NOT EXISTS idx_worktree_locks_active
        ON worktree_locks(scope_key, released_at, expires_at);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_locks_one_active
        ON worktree_locks(scope_key)
        WHERE released_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_worktree_events_worktree
        ON worktree_events(worktree_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_worktree_cleanup_attempts_worktree
        ON worktree_cleanup_attempts(worktree_id, attempted_at DESC);

      CREATE INDEX IF NOT EXISTS idx_prepared_diffs_status
        ON prepared_diffs(status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_prepared_diffs_repo
        ON prepared_diffs(repo_id, pr_number, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_prepared_diff_approvals_pending
        ON prepared_diff_approvals(status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_prepared_diff_approvals_diff
        ON prepared_diff_approvals(prepared_diff_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_kilo_tasks_status
        ON kilo_tasks(status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_kilo_tasks_repo
        ON kilo_tasks(repo_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_kilo_tasks_session
        ON kilo_tasks(root_session_id);

      CREATE INDEX IF NOT EXISTS idx_kilo_task_events_task
        ON kilo_task_events(task_id, event_index);

      CREATE INDEX IF NOT EXISTS idx_kilo_session_audit_session
        ON kilo_session_audit(session_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_kilo_result_state_updated
        ON kilo_result_state(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_kilo_result_events_task
        ON kilo_result_events(task_id, created_at DESC);
`;
