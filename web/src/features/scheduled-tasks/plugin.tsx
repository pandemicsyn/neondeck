import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  cleanupScheduledTaskRun,
  clearScheduledWorkspaceQuarantine,
  createScheduledInstruction,
  getRepoRegistry,
  getScheduledTaskRun,
  getScheduledTaskRuns,
  getScheduledTasks,
  getScheduledWorkspaceQuarantines,
  getWorkspaceProviders,
  pauseScheduledTask,
  retainScheduledTaskRun,
  resumeScheduledTask,
  retryScheduledTaskRun,
  runScheduledTaskNow,
  type ScheduledRunArtifact,
  type ScheduledTask,
  type ScheduledTaskRun,
  type TaskWorkspace,
} from '../../api';
import { Badge, Button, EmptyState, ScrollArea } from '../../components/ui';
import { queryErrorMessage, queryKeys } from '../../lib/query';
import type { DisplayPlugin } from '../../types';

const control =
  'h-8 w-full border border-line bg-field px-2 font-mono text-[11px] text-ink outline-none focus:border-primary';

export const ScheduledTasksPlugin = {
  id: 'scheduled-tasks',
  title: 'Scheduled tasks',
  kind: 'data',
  defaultConfig: {},
  Component: ScheduledTasksPanel,
} satisfies DisplayPlugin<Record<string, never>>;

function ScheduledTasksPanel() {
  const client = useQueryClient();
  const tasks = useQuery({
    queryKey: queryKeys.scheduledTasks,
    queryFn: getScheduledTasks,
    refetchInterval: 15_000,
  });
  const providers = useQuery({
    queryKey: queryKeys.workspaceProviders,
    queryFn: getWorkspaceProviders,
    refetchInterval: 30_000,
  });
  const repos = useQuery({
    queryKey: queryKeys.repoRegistry,
    queryFn: getRepoRegistry,
    refetchInterval: 30_000,
  });
  const quarantines = useQuery({
    queryKey: queryKeys.scheduledWorkspaceQuarantines,
    queryFn: getScheduledWorkspaceQuarantines,
    refetchInterval: 15_000,
  });
  const [taskId, setTaskId] = useState<string>();
  const [runId, setRunId] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [cleanupConfirmationRunId, setCleanupConfirmationRunId] =
    useState<string>();
  const [quarantineClearConfirmation, setQuarantineClearConfirmation] =
    useState<string>();
  const selectedTask =
    tasks.data?.tasks.find((task) => task.id === taskId) ??
    tasks.data?.tasks[0];
  useEffect(() => {
    if (!taskId && tasks.data?.tasks[0]) setTaskId(tasks.data.tasks[0].id);
  }, [taskId, tasks.data]);
  const runs = useQuery({
    queryKey: queryKeys.scheduledTaskRuns(selectedTask?.id),
    queryFn: () => getScheduledTaskRuns(selectedTask!.id),
    enabled: Boolean(selectedTask),
    refetchInterval: 10_000,
  });
  useEffect(() => {
    if (!runId && runs.data?.runs[0]) setRunId(runs.data.runs[0].id);
  }, [runId, runs.data]);
  const detail = useQuery({
    queryKey: queryKeys.scheduledTaskRun(runId),
    queryFn: () => getScheduledTaskRun(runId!),
    enabled: Boolean(runId),
    refetchInterval: 10_000,
  });
  const action = useMutation({
    mutationFn: async (input: {
      action: 'run' | 'pause' | 'resume' | 'retry' | 'retain' | 'cleanup';
      id: string;
    }) => {
      if (input.action === 'run') return runScheduledTaskNow(input.id);
      if (input.action === 'pause') return pauseScheduledTask(input.id);
      if (input.action === 'resume') return resumeScheduledTask(input.id);
      if (input.action === 'retry') return retryScheduledTaskRun(input.id);
      if (input.action === 'retain') return retainScheduledTaskRun(input.id);
      return cleanupScheduledTaskRun(input.id, true);
    },
    onSuccess: () =>
      void Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.scheduledTasks }),
        client.invalidateQueries({ queryKey: ['scheduled-task-runs'] }),
        client.invalidateQueries({ queryKey: ['scheduled-task-run'] }),
      ]),
  });
  const clearQuarantine = useMutation({
    mutationFn: (physicalResourceKey: string) =>
      clearScheduledWorkspaceQuarantine(physicalResourceKey, true),
    onSuccess: () => {
      setQuarantineClearConfirmation(undefined);
      void client.invalidateQueries({
        queryKey: queryKeys.scheduledWorkspaceQuarantines,
      });
    },
  });

  if (tasks.isLoading)
    return (
      <EmptyState
        title="Loading schedules"
        detail="Reading task and run history."
      />
    );
  if (tasks.error)
    return (
      <EmptyState
        title="Schedules unavailable"
        detail={queryErrorMessage(tasks.error)}
        tone="alert"
      />
    );

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(220px,0.78fr)_minmax(360px,1.55fr)] bg-panel">
      <aside className="flex min-h-0 flex-col border-r border-line">
        <header className="flex items-center justify-between border-b border-line px-3 py-2">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
              Schedules
            </p>
            <p className="text-sm font-semibold text-ink">
              {tasks.data?.tasks.length ?? 0} tasks
            </p>
          </div>
          <Button onClick={() => setEditing((value) => !value)}>
            {editing ? 'Close' : 'New task'}
          </Button>
        </header>
        <ScrollArea className="flex-1 p-2">
          {providers.data && (
            <div className="mb-2 border border-line bg-field p-2">
              <p className="mb-1 font-mono text-[10px] uppercase text-muted">
                Workspace providers
              </p>
              <div className="flex flex-wrap gap-1">
                {providers.data.providers.map(({ descriptor, readiness }) => (
                  <Badge
                    key={descriptor.id}
                    className={
                      readiness.ready
                        ? 'border-primary text-primary'
                        : 'border-accent text-accent'
                    }
                    title={readiness.message}
                  >
                    {descriptor.label} · {readiness.ready ? 'ready' : 'setup'}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {quarantines.data?.quarantines.map((quarantine) => (
            <div
              key={quarantine.physicalResourceKey}
              className="mb-2 border border-accent bg-field p-2"
            >
              <p className="font-mono text-[10px] uppercase text-accent">
                Remote resource quarantined
              </p>
              <p className="mt-1 break-all font-mono text-[10px] text-ink">
                {quarantine.providerId} · {quarantine.physicalResourceKey}
              </p>
              <p className="mt-1 text-[11px] text-muted">{quarantine.reason}</p>
              {quarantineClearConfirmation ===
              quarantine.physicalResourceKey ? (
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    disabled={clearQuarantine.isPending}
                    onClick={() =>
                      clearQuarantine.mutate(quarantine.physicalResourceKey)
                    }
                  >
                    Confirm settled and clear
                  </Button>
                  <Button
                    disabled={clearQuarantine.isPending}
                    onClick={() => setQuarantineClearConfirmation(undefined)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  className="mt-2"
                  onClick={() =>
                    setQuarantineClearConfirmation(
                      quarantine.physicalResourceKey,
                    )
                  }
                >
                  Clear quarantine…
                </Button>
              )}
              {clearQuarantine.error ? (
                <p className="mt-1 text-[11px] text-danger">
                  {queryErrorMessage(clearQuarantine.error)}
                </p>
              ) : null}
            </div>
          ))}
          <div className="space-y-1">
            {tasks.data?.tasks.map((task) => {
              const workspace = task.spec.workspace;
              return (
                <button
                  key={task.id}
                  className={`w-full border px-2.5 py-2 text-left ${selectedTask?.id === task.id ? 'border-primary bg-field' : 'border-line bg-soft hover:border-muted'}`}
                  onClick={() => {
                    setTaskId(task.id);
                    setRunId(undefined);
                  }}
                >
                  <span className="block truncate font-mono text-[11px] text-ink">
                    {task.spec.prompt ?? task.id}
                  </span>
                  <span className="mt-1 flex items-center justify-between gap-2 font-mono text-[10px] text-muted">
                    <span>
                      {workspace?.kind === 'repository'
                        ? `${workspace.providerId} · ${workspace.git.mode}`
                        : 'virtual'}
                    </span>
                    <span>
                      {task.activeRun
                        ? 'running'
                        : task.enabled
                          ? 'enabled'
                          : 'paused'}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </aside>
      <section className="min-h-0 overflow-hidden">
        {editing ? (
          <TaskEditor
            repos={repos.data?.repos ?? []}
            providers={providers.data?.providers ?? []}
            defaultProviderId={providers.data?.defaultProviderId ?? 'local'}
            defaultRemoteProviderId={
              providers.data?.defaultRemoteProviderId ?? null
            }
            onCreated={() => {
              setEditing(false);
              void client.invalidateQueries({
                queryKey: queryKeys.scheduledTasks,
              });
            }}
          />
        ) : selectedTask ? (
          <TaskDetail
            task={selectedTask}
            runs={runs.data?.runs ?? []}
            runId={runId}
            setRunId={setRunId}
            detail={detail.data}
            action={(kind, id) => action.mutate({ action: kind, id })}
            cleanupConfirmationRunId={cleanupConfirmationRunId}
            setCleanupConfirmationRunId={setCleanupConfirmationRunId}
            pending={action.isPending}
            actionError={
              action.error ? queryErrorMessage(action.error) : undefined
            }
          />
        ) : (
          <EmptyState
            title="No scheduled tasks"
            detail="Create a virtual reminder or a repository task with an explicit workspace policy."
          />
        )}
      </section>
    </div>
  );
}

export function TaskEditor({
  repos,
  providers,
  defaultProviderId,
  defaultRemoteProviderId,
  onCreated,
}: {
  repos: Array<{ id: string; defaultBranch: string }>;
  providers: Array<{
    descriptor: { id: string; label: string };
    readiness: { ready: boolean };
    readinessByLifecycle: Record<
      'per-run' | 'reuse-task' | 'existing',
      { ready: boolean; message: string }
    >;
  }>;
  defaultProviderId: string;
  defaultRemoteProviderId?: string | null;
  onCreated(): void;
}) {
  const [virtual, setVirtual] = useState(repos.length === 0);
  const [advanced, setAdvanced] = useState(false);
  const [lifecycle, setLifecycle] = useState<
    'per-run' | 'reuse-task' | 'existing'
  >('per-run');
  const [providerId, setProviderId] = useState(defaultProviderId);
  const [repoId, setRepoId] = useState(repos[0]?.id ?? '');
  const [targetRef, setTargetRef] = useState(repos[0]?.defaultBranch ?? 'main');
  const [gitMode, setGitMode] = useState<
    'run-branch' | 'task-branch' | 'direct-branch'
  >('run-branch');
  const [revisionMode, setRevisionMode] = useState<
    'latest-each-run' | 'pinned' | 'continue'
  >('latest-each-run');
  const [authority, setAuthority] = useState<
    'read-only' | 'trusted-workspace' | 'delivery-enabled'
  >('read-only');
  const [existingResourceId, setExistingResourceId] = useState('');
  const [overlap, setOverlap] = useState<
    'skip' | 'queue-one' | 'allow-parallel'
  >('skip');
  const [editorError, setEditorError] = useState<string>();
  const providerReadiness = providers.find(
    (provider) => provider.descriptor.id === providerId,
  )?.readinessByLifecycle[lifecycle];
  useEffect(() => {
    if (repos.some((repo) => repo.id === repoId)) return;
    const first = repos[0];
    setRepoId(first?.id ?? '');
    setTargetRef(first?.defaultBranch ?? 'main');
  }, [repoId, repos]);
  const create = useMutation({
    mutationFn: createScheduledInstruction,
    onSuccess: onCreated,
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const policyIssue = scheduledEditorPolicyIssue({
      lifecycle,
      gitMode,
      revisionMode,
      overlap,
    });
    if (policyIssue) {
      setEditorError(policyIssue);
      return;
    }
    setEditorError(undefined);
    const data = new FormData(event.currentTarget);
    const repo = repos.find((item) => item.id === repoId) ?? repos[0];
    void create.mutate({
      prompt: String(data.get('prompt')),
      trigger: {
        kind: 'cron',
        expression: String(data.get('cron')),
        timezone: String(data.get('timezone')),
      },
      target: { kind: 'agent' },
      confirm: data.get('confirm') === 'true',
      workspace: virtual
        ? { kind: 'virtual' }
        : {
            kind: 'repository',
            repoId: repo?.id,
            providerId: String(data.get('providerId')),
            subdirectory: String(data.get('subdirectory') || '') || undefined,
            resource: {
              lifecycle,
              existingResourceId:
                lifecycle === 'existing'
                  ? existingResourceId.trim()
                  : undefined,
            },
            revision: {
              ref: String(data.get('ref') || repo?.defaultBranch || 'main'),
              mode: revisionMode,
              sha:
                revisionMode === 'pinned' ? String(data.get('sha')) : undefined,
            },
            git: {
              mode: gitMode,
              branch:
                gitMode === 'direct-branch'
                  ? String(data.get('branch'))
                  : undefined,
              acknowledgeDirectBranch: gitMode === 'direct-branch',
            },
            authority: String(data.get('authority')),
            retention: String(data.get('retention')),
            overlap,
          },
    });
  }
  return (
    <ScrollArea className="h-full">
      <form className="mx-auto max-w-3xl p-4" onSubmit={submit}>
        <div className="mb-4 border-b border-line pb-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-primary">
            New scheduled task
          </p>
          <h2 className="mt-1 text-lg font-semibold text-ink">
            Define time, workspace, Git, and authority independently.
          </h2>
        </div>
        <Field label="Instruction">
          <textarea
            name="prompt"
            required
            maxLength={8000}
            className={`${control} h-24 py-2`}
            placeholder="Run the unit tests and investigate new failures."
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cron">
            <input name="cron" className={control} defaultValue="0 9 * * 1-5" />
          </Field>
          <Field label="Timezone">
            <input
              name="timezone"
              className={control}
              defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}
            />
          </Field>
        </div>
        <div className="my-3 grid grid-cols-2 border border-line">
          <button
            type="button"
            className={`h-10 font-mono text-xs ${virtual ? 'bg-primary text-bg' : 'bg-soft text-muted'}`}
            onClick={() => setVirtual(true)}
          >
            Virtual workspace
          </button>
          <button
            type="button"
            className={`h-10 border-l border-line font-mono text-xs ${!virtual ? 'bg-primary text-bg' : 'bg-soft text-muted'}`}
            onClick={() => setVirtual(false)}
          >
            Repository workspace
          </button>
        </div>
        {!virtual && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Repository">
                <Select
                  name="repoId"
                  value={repoId}
                  onChange={(event) => {
                    const nextRepo = repos.find(
                      (repo) => repo.id === event.target.value,
                    );
                    setRepoId(event.target.value);
                    setTargetRef(nextRepo?.defaultBranch ?? 'main');
                  }}
                  options={repos.map((repo) => [repo.id, repo.id])}
                />
              </Field>
              <Field label="Provider">
                <Select
                  name="providerId"
                  value={providerId}
                  onChange={(event) => setProviderId(event.target.value)}
                  options={providers.map((provider) => [
                    provider.descriptor.id,
                    `${provider.descriptor.label}${provider.descriptor.id === defaultRemoteProviderId ? ' — default remote' : ''}${provider.readinessByLifecycle[lifecycle].ready ? '' : ' — setup required'}`,
                  ])}
                />
                {providerId === 'local' && defaultRemoteProviderId ? (
                  <button
                    type="button"
                    className="mt-1 font-mono text-[10px] text-primary hover:underline"
                    onClick={() => setProviderId(defaultRemoteProviderId)}
                  >
                    Use default remote · {defaultRemoteProviderId}
                  </button>
                ) : null}
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Resource">
                <Select
                  name="lifecycle"
                  value={lifecycle}
                  onChange={(event) => {
                    const next = event.target.value as
                      'per-run' | 'reuse-task' | 'existing';
                    setLifecycle(next);
                    if (next === 'existing') setAdvanced(true);
                    if (next === 'per-run' && gitMode !== 'run-branch') {
                      setGitMode('run-branch');
                      if (revisionMode === 'continue')
                        setRevisionMode('latest-each-run');
                    }
                  }}
                  options={[
                    ['per-run', 'Fresh each run'],
                    ['reuse-task', 'Reuse task workspace'],
                    ['existing', 'Existing workspace'],
                  ]}
                />
              </Field>
              <Field label="Revision">
                <Select
                  name="revisionMode"
                  value={revisionMode}
                  onChange={(event) => {
                    const next = event.target.value as typeof revisionMode;
                    setRevisionMode(next);
                    if (next === 'continue') {
                      setGitMode('task-branch');
                      if (lifecycle === 'per-run') setLifecycle('reuse-task');
                      if (overlap === 'allow-parallel') setOverlap('skip');
                    } else if (gitMode === 'task-branch')
                      setGitMode('run-branch');
                  }}
                  options={
                    gitMode === 'task-branch'
                      ? [['continue', 'Continue previous state']]
                      : [
                          ['latest-each-run', 'Latest from branch'],
                          ['pinned', 'Pinned commit'],
                        ]
                  }
                />
              </Field>
              <Field label="Git changes">
                <Select
                  name="gitMode"
                  value={gitMode}
                  onChange={(event) => {
                    const next = event.target.value as typeof gitMode;
                    setGitMode(next);
                    if (next === 'task-branch') {
                      setRevisionMode('continue');
                      if (lifecycle === 'per-run') setLifecycle('reuse-task');
                      if (overlap === 'allow-parallel') setOverlap('skip');
                    } else if (next === 'direct-branch') {
                      if (lifecycle === 'per-run') setLifecycle('reuse-task');
                      if (overlap === 'allow-parallel') setOverlap('skip');
                      if (revisionMode === 'continue')
                        setRevisionMode('latest-each-run');
                    } else if (revisionMode === 'continue')
                      setRevisionMode('latest-each-run');
                  }}
                  options={[
                    ['run-branch', 'Run branch'],
                    ['task-branch', 'Persistent task branch'],
                    ['direct-branch', 'Direct branch (advanced)'],
                  ]}
                />
              </Field>
            </div>
            {providerReadiness && !providerReadiness.ready && (
              <p className="mb-3 border border-accent bg-soft p-2 text-xs text-accent">
                {providerReadiness.message}
              </p>
            )}
            {lifecycle === 'existing' && (
              <p className="mb-3 border border-line bg-soft p-2 text-xs text-muted">
                Existing resources are adopted, never deleted automatically, and
                physically serialized across every task that shares the same
                provider workspace. Enter its resource ID under advanced policy.
              </p>
            )}
            {gitMode === 'direct-branch' && (
              <p className="mb-3 border border-accent bg-soft p-2 text-xs text-accent">
                Direct branch is serialized and never force-reset. For local
                workspaces, a branch already held by the primary checkout—such
                as main—cannot be used; select a dedicated existing worktree or
                a schedule branch.
              </p>
            )}
            {gitMode === 'task-branch' && (
              <p className="mb-3 border border-line bg-soft p-2 text-xs text-muted">
                Persistent task branches always continue from the previous run.
                Choose a run branch for latest-from-ref or pinned runs.
              </p>
            )}
            {(revisionMode === 'pinned' || gitMode === 'direct-branch') && (
              <div className="grid grid-cols-2 gap-3">
                {revisionMode === 'pinned' && (
                  <Field label="Full pinned commit SHA">
                    <input
                      name="sha"
                      required
                      minLength={40}
                      maxLength={64}
                      pattern="(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})"
                      className={control}
                    />
                  </Field>
                )}
                {gitMode === 'direct-branch' && (
                  <Field label="Direct branch">
                    <input name="branch" required className={control} />
                  </Field>
                )}
              </div>
            )}
            <div className="grid grid-cols-3 gap-3">
              <Field label="Target ref">
                <input
                  name="ref"
                  className={control}
                  value={targetRef}
                  onChange={(event) => setTargetRef(event.target.value)}
                />
              </Field>
              <Field label="Authority">
                <Select
                  name="authority"
                  value={authority}
                  onChange={(event) =>
                    setAuthority(event.target.value as typeof authority)
                  }
                  options={[
                    ['read-only', 'Read-only tools'],
                    ['trusted-workspace', 'Shell + network'],
                    ['delivery-enabled', 'Shell + network (reserved)'],
                  ]}
                />
                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                  Shell modes strip ambient credentials, but commands retain
                  network access. Local shell tasks can also address host paths.
                  No scheduled delivery tool is mounted in this release.
                </p>
                {authority !== 'read-only' && (
                  <label className="mt-2 flex items-start gap-2 text-[10px] leading-4 text-accent">
                    <input
                      name="confirm"
                      type="checkbox"
                      value="true"
                      required
                    />
                    I confirm this recurring task may run arbitrary
                    credential-stripped shell commands with network access.
                  </label>
                )}
              </Field>
              <Field label="Retention">
                <Select
                  name="retention"
                  options={[
                    ['cleanup-success', 'Cleanup no-op success'],
                    ['retain-always', 'Retain always'],
                  ]}
                />
              </Field>
            </div>
            <button
              type="button"
              className="my-2 font-mono text-[11px] text-primary"
              onClick={() => setAdvanced((value) => !value)}
            >
              {advanced ? '− Hide advanced policy' : '+ Advanced policy'}
            </button>
            {advanced && (
              <div className="grid grid-cols-2 gap-3 border border-line bg-soft p-3">
                <Field label="Existing resource ID">
                  <input
                    name="existingResourceId"
                    className={control}
                    value={existingResourceId}
                    required={lifecycle === 'existing'}
                    onChange={(event) =>
                      setExistingResourceId(event.target.value)
                    }
                  />
                </Field>
                <Field label="Repo subdirectory">
                  <input name="subdirectory" className={control} />
                </Field>
                <Field label="Overlap">
                  <Select
                    name="overlap"
                    value={overlap}
                    onChange={(event) => {
                      const next = event.target.value as
                        'skip' | 'queue-one' | 'allow-parallel';
                      setOverlap(next);
                      if (next === 'allow-parallel') {
                        setLifecycle('per-run');
                        setGitMode('run-branch');
                        if (revisionMode === 'continue')
                          setRevisionMode('latest-each-run');
                      }
                    }}
                    options={[
                      ['skip', 'Skip while active'],
                      ['queue-one', 'Queue one'],
                      ['allow-parallel', 'Allow parallel'],
                    ]}
                  />
                </Field>
              </div>
            )}
          </>
        )}
        {create.error && (
          <p className="mt-3 text-xs text-accent">
            {queryErrorMessage(create.error)}
          </p>
        )}
        {editorError && (
          <p className="mt-3 text-xs text-accent">{editorError}</p>
        )}
        <Button
          className="mt-4 border-primary text-primary"
          disabled={create.isPending}
        >
          {create.isPending ? 'Creating…' : 'Create scheduled task'}
        </Button>
      </form>
    </ScrollArea>
  );
}

export function scheduledEditorPolicyIssue(input: {
  lifecycle: 'per-run' | 'reuse-task' | 'existing';
  gitMode: 'run-branch' | 'task-branch' | 'direct-branch';
  revisionMode: 'latest-each-run' | 'pinned' | 'continue';
  overlap: 'skip' | 'queue-one' | 'allow-parallel';
}) {
  if (
    input.revisionMode === 'continue' &&
    (input.gitMode !== 'task-branch' || input.lifecycle === 'per-run')
  ) {
    return 'Continue mode requires a persistent task branch and reusable workspace.';
  }
  if (
    input.gitMode === 'task-branch' &&
    (input.revisionMode !== 'continue' ||
      input.lifecycle === 'per-run' ||
      input.overlap === 'allow-parallel')
  ) {
    return 'Persistent task branches require a reusable serialized workspace in continue mode.';
  }
  if (
    input.gitMode === 'direct-branch' &&
    (input.lifecycle === 'per-run' || input.overlap === 'allow-parallel')
  ) {
    return 'Direct branches require a reusable serialized workspace.';
  }
  if (
    input.overlap === 'allow-parallel' &&
    (input.lifecycle !== 'per-run' || input.gitMode !== 'run-branch')
  ) {
    return 'Parallel runs require fresh per-run workspaces and run branches.';
  }
  return undefined;
}

function TaskDetail({
  task,
  runs,
  runId,
  setRunId,
  detail,
  action,
  pending,
  actionError,
  cleanupConfirmationRunId,
  setCleanupConfirmationRunId,
}: {
  task: ScheduledTask;
  runs: ScheduledTaskRun[];
  runId?: string;
  setRunId(id: string): void;
  detail?: {
    run: ScheduledTaskRun;
    workspace?: TaskWorkspace;
    artifacts: ScheduledRunArtifact[];
  };
  action(
    kind: 'run' | 'pause' | 'resume' | 'retry' | 'retain' | 'cleanup',
    id: string,
  ): void;
  pending: boolean;
  actionError?: string;
  cleanupConfirmationRunId?: string;
  setCleanupConfirmationRunId(id?: string): void;
}) {
  const workspace = detail?.workspace;
  const workspaceUnsettled =
    Boolean(workspace?.lockOwner) ||
    Boolean(
      workspace &&
      ['provisioning', 'preparing', 'ready', 'active', 'collecting'].includes(
        workspace.status,
      ),
    );
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_1fr]">
      <header className="border-b border-line px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase text-primary">
              {task.spec.kind}
            </p>
            <h2 className="mt-1 line-clamp-2 text-base font-semibold text-ink">
              {task.spec.prompt ?? task.id}
            </h2>
            <p className="mt-1 font-mono text-[10px] text-muted">
              next {task.nextRunAt ?? 'paused'} · last{' '}
              {task.lastRunAt ?? 'never'}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              disabled={pending}
              onClick={() => action(task.enabled ? 'pause' : 'resume', task.id)}
            >
              {task.enabled ? 'Pause' : 'Resume'}
            </Button>
            <Button disabled={pending} onClick={() => action('run', task.id)}>
              Run now
            </Button>
          </div>
        </div>
        {actionError && (
          <p role="alert" className="mt-2 text-xs text-accent">
            {actionError}
          </p>
        )}
      </header>
      <div className="grid min-h-0 grid-cols-[180px_1fr]">
        <ScrollArea className="border-r border-line p-2">
          <p className="mb-2 font-mono text-[10px] uppercase text-muted">
            Run history
          </p>
          {runs.map((run) => (
            <button
              key={run.id}
              onClick={() => setRunId(run.id)}
              className={`mb-1 w-full border p-2 text-left ${runId === run.id ? 'border-primary bg-field' : 'border-line bg-soft'}`}
            >
              <span className="block font-mono text-[10px] text-ink">
                {run.status} · {run.outcome}
              </span>
              <span className="block truncate font-mono text-[9px] text-muted">
                {new Date(run.startedAt).toLocaleString()}
              </span>
            </button>
          ))}
        </ScrollArea>
        <ScrollArea className="p-4">
          {detail ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1">
                <Badge>{detail.run.status}</Badge>
                {workspace && (
                  <>
                    <Badge className="border-primary text-primary">
                      {workspace.providerId}
                    </Badge>
                    <Badge>{workspace.lifecycle}</Badge>
                    <Badge>{workspace.status}</Badge>
                    <Badge>{workspace.authority}</Badge>
                  </>
                )}
              </div>
              {workspace && (
                <section className="border border-line bg-soft p-3">
                  <WorkspaceIdentity workspace={workspace} />
                  <p className="font-mono text-[10px] uppercase text-muted">
                    Revision path
                  </p>
                  <p className="mt-1 break-all font-mono text-[11px] text-ink">
                    {workspace.requestedRef} @{' '}
                    {workspace.baseSha?.slice(0, 12) ?? 'unresolved'} →{' '}
                    {workspace.branchName ?? 'no branch'} →{' '}
                    {workspace.finalSha?.slice(0, 12) ?? 'running'}
                  </p>
                  <p className="mt-2 break-all font-mono text-[10px] text-muted">
                    {workspace.workspaceRoot}
                  </p>
                  {(workspace.retentionReason || workspace.providerError) && (
                    <p className="mt-2 text-xs text-accent">
                      {workspace.providerError ?? workspace.retentionReason}
                    </p>
                  )}
                  {workspace.status !== 'deleted' && (
                    <div className="mt-3 flex gap-2">
                      <Button
                        disabled={pending || workspaceUnsettled}
                        title={
                          workspaceUnsettled
                            ? 'Wait for the active run to settle before retaining this workspace.'
                            : undefined
                        }
                        onClick={() => action('retain', detail.run.id)}
                      >
                        Retain
                      </Button>
                      {cleanupConfirmationRunId === detail.run.id ? (
                        <div className="flex items-center gap-2 border border-accent px-2 py-1">
                          <span className="text-[10px] text-accent">
                            {workspace.lifecycle === 'existing'
                              ? 'Detach this task record?'
                              : 'Delete this workspace?'}
                          </span>
                          <Button
                            disabled={pending || workspaceUnsettled}
                            onClick={() => {
                              action('cleanup', detail.run.id);
                              setCleanupConfirmationRunId(undefined);
                            }}
                          >
                            Confirm
                          </Button>
                          <Button
                            disabled={pending}
                            onClick={() =>
                              setCleanupConfirmationRunId(undefined)
                            }
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          disabled={pending || workspaceUnsettled}
                          title={
                            workspaceUnsettled
                              ? 'Cleanup is unavailable while the workspace is active or leased.'
                              : workspace.lifecycle === 'existing'
                                ? 'Detach this task record while preserving existing provider infrastructure.'
                                : undefined
                          }
                          onClick={() =>
                            setCleanupConfirmationRunId(detail.run.id)
                          }
                        >
                          {workspace.lifecycle === 'existing'
                            ? 'Detach'
                            : 'Clean up'}
                        </Button>
                      )}
                    </div>
                  )}
                </section>
              )}
              <section>
                <div className="mb-1 flex items-center justify-between">
                  <p className="font-mono text-[10px] uppercase text-muted">
                    Result
                  </p>
                  {detail.run.status === 'failed' && (
                    <Button
                      disabled={pending}
                      onClick={() => action('retry', detail.run.id)}
                    >
                      Retry
                    </Button>
                  )}
                </div>
                <pre className="whitespace-pre-wrap border border-line bg-field p-3 font-mono text-[10px] leading-4 text-ink">
                  {detail.run.message}
                  {detail.run.error ? `\n\n${detail.run.error}` : ''}
                </pre>
              </section>
              <section>
                <p className="mb-1 font-mono text-[10px] uppercase text-muted">
                  Output and artifacts
                </p>
                {detail.artifacts.length === 0 ? (
                  <p className="border border-line bg-soft p-3 text-xs text-muted">
                    No captured artifacts.
                  </p>
                ) : (
                  detail.artifacts.map((artifact) => (
                    <details
                      key={artifact.id}
                      className="mb-1 border border-line bg-soft"
                    >
                      <summary className="cursor-pointer px-3 py-2 font-mono text-[10px] text-ink">
                        {artifact.kind} · {artifact.summary}
                        {artifact.redacted ? ' · redacted' : ''}
                        {artifact.truncated ? ' · truncated' : ''}
                      </summary>
                      {artifact.content && (
                        <pre className="max-h-72 overflow-auto border-t border-line bg-field p-3 font-mono text-[10px] leading-4 text-ink">
                          {artifact.content}
                        </pre>
                      )}
                    </details>
                  ))
                )}
              </section>
            </div>
          ) : (
            <EmptyState
              title="Select a run"
              detail="Run output, exact revision, commands, diff, and retention appear here."
            />
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

export function WorkspaceIdentity({ workspace }: { workspace: TaskWorkspace }) {
  return (
    <dl className="mb-3 grid gap-x-4 gap-y-2 border-b border-line pb-3 sm:grid-cols-2">
      <div className="min-w-0">
        <dt className="font-mono text-[10px] text-muted">Repository</dt>
        <dd className="mt-0.5 break-all font-mono text-[11px] text-ink">
          {workspace.repoSnapshot.github.owner}/
          {workspace.repoSnapshot.github.name}
        </dd>
        <dd className="break-all font-mono text-[9px] text-muted">
          {workspace.repoId}
          {!workspace.repoSnapshot.verified ? ' · legacy identity' : ''}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="font-mono text-[10px] text-muted">Provider resource</dt>
        <dd className="mt-0.5 break-all font-mono text-[11px] text-ink">
          {workspace.providerResourceId}
        </dd>
        <dd className="break-all font-mono text-[9px] text-muted">
          {workspace.providerId}
        </dd>
      </div>
    </dl>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block font-mono text-[10px] uppercase text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}
function Select({
  name,
  options,
  defaultValue,
  value,
  onChange,
}: {
  name: string;
  options: string[][];
  defaultValue?: string;
  value?: string;
  onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
}) {
  return (
    <select
      name={name}
      className={control}
      defaultValue={defaultValue}
      value={value}
      onChange={onChange}
    >
      {options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}
