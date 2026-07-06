import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import {
  createRoutine,
  deleteRoutine,
  getRoutineConfig,
  getRoutines,
  getRuntimeSkills,
  runRoutine,
  setRoutineEnabled,
  updateRoutine,
  updateRoutineConfig,
  type RoutineDelivery,
  type RoutineListItem,
  type RoutineScheduleKind,
  type RuntimeSkill,
} from '../api';
import {
  Badge,
  Button,
  EmptyState,
  MiniEmpty,
  ScrollArea,
} from '../components/ui';
import { relativeTime } from '../lib/format';
import { queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';
import { parsePositiveIntegerConfig } from './config';

type RoutinesPanelConfig = {
  limit: number;
  refreshSeconds: number;
};

type RoutineFormState = {
  name: string;
  prompt: string;
  scheduleKind: RoutineScheduleKind;
  schedule: string;
  delivery: RoutineDelivery;
  skills: string[];
  scopeRepoId: string;
  scopeCwd: string;
  repeatLimit: string;
};

const routinesPanelDefaultConfig = {
  limit: 8,
  refreshSeconds: 30,
};

const emptyForm: RoutineFormState = {
  name: '',
  prompt: '',
  scheduleKind: 'interval',
  schedule: '900',
  delivery: 'notification',
  skills: [],
  scopeRepoId: '',
  scopeCwd: '',
  repeatLimit: '',
};

export const RoutinesPanelPlugin = {
  id: 'routines-panel',
  title: 'Routines',
  kind: 'data',
  defaultConfig: routinesPanelDefaultConfig,
  parseConfig: (config) =>
    parsePositiveIntegerConfig(routinesPanelDefaultConfig, config),
  Component({ config }) {
    const queryClient = useQueryClient();
    const routinesQuery = useQuery({
      queryKey: queryKeys.routines,
      queryFn: getRoutines,
      refetchInterval: Math.max(10, config.refreshSeconds) * 1000,
    });
    const configQuery = useQuery({
      queryKey: queryKeys.routineConfig,
      queryFn: getRoutineConfig,
      refetchInterval: Math.max(10, config.refreshSeconds) * 1000,
    });
    const skillsQuery = useQuery({
      queryKey: queryKeys.runtimeSkills,
      queryFn: getRuntimeSkills,
      staleTime: 60_000,
    });
    const configMutation = useMutation({
      mutationFn: (enabled: boolean) => updateRoutineConfig(enabled),
      onSuccess() {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.routineConfig,
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.routines });
      },
    });

    if (routinesQuery.isLoading || configQuery.isLoading) {
      return (
        <EmptyState title="Routines loading" detail="Reading schedule state." />
      );
    }

    if (routinesQuery.error || configQuery.error) {
      return (
        <EmptyState
          title="Routines unavailable"
          detail={queryErrorMessage(routinesQuery.error ?? configQuery.error)}
        />
      );
    }

    const routines = routinesQuery.data?.routines ?? [];
    const visible = routines.slice(0, config.limit);
    const enabled = configQuery.data?.routines.enabled ?? true;
    const lastTickAt = configQuery.data?.scheduler.lastTickAt ?? null;
    const activeSkills =
      skillsQuery.data?.skills.filter((skill) => skill.status === 'active') ??
      [];

    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
          <span className="text-primary">ROUTINES</span>
          <div className="flex items-center gap-1.5">
            <Badge className={enabled ? 'text-primary' : 'text-accent'}>
              {enabled ? 'enabled' : 'disabled'}
            </Badge>
            <Badge>{routines.length}</Badge>
            <Badge>tick {timeOrNever(lastTickAt)}</Badge>
            <Button
              className="min-h-[24px] bg-transparent px-2 py-0.5 text-[10px] text-muted"
              disabled={configMutation.isPending}
              onClick={() => configMutation.mutate(!enabled)}
              title={
                configMutation.error
                  ? queryErrorMessage(configMutation.error)
                  : undefined
              }
              type="button"
            >
              {enabled ? 'disable' : 'enable'}
            </Button>
          </div>
        </header>
        {!enabled ? (
          <div className="border-b border-accent/50 bg-soft px-3 py-1.5 font-mono text-[10px] text-accent">
            ROUTINE RUNS PAUSED
          </div>
        ) : null}
        <ScrollArea className="flex-1">
          <div className="space-y-2 p-3">
            <RoutineComposer activeSkills={activeSkills} />
            {visible.length === 0 ? (
              <MiniEmpty label="No routines scheduled." />
            ) : (
              visible.map((routine) => (
                <RoutineRow
                  activeSkills={activeSkills}
                  routinesEnabled={enabled}
                  key={routine.id}
                  routine={routine}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    );
  },
} satisfies DisplayPlugin<RoutinesPanelConfig>;

function RoutineComposer({ activeSkills }: { activeSkills: RuntimeSkill[] }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        className="flex w-full items-center justify-between border border-line bg-field px-2.5 py-2 font-mono text-[10px] text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
        onClick={() => setOpen(true)}
        type="button"
      >
        <span>NEW ROUTINE</span>
        <span>create</span>
      </button>
    );
  }
  return (
    <RoutineForm
      activeSkills={activeSkills}
      mode="create"
      onCancel={() => setOpen(false)}
      routine={null}
    />
  );
}

function RoutineRow({
  activeSkills,
  routinesEnabled,
  routine,
}: {
  activeSkills: RuntimeSkill[];
  routinesEnabled: boolean;
  routine: RoutineListItem;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.routines });
    void queryClient.invalidateQueries({ queryKey: queryKeys.reports });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.chatSessions,
    });
  };
  const runMutation = useMutation({
    mutationFn: () => runRoutine(routine.id),
    onSuccess: invalidate,
  });
  const enabledMutation = useMutation({
    mutationFn: () => setRoutineEnabled(routine.id, !routine.enabled),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteRoutine(routine.id),
    onSuccess() {
      setConfirmDelete(false);
      invalidate();
    },
  });

  if (editing) {
    return (
      <RoutineForm
        activeSkills={activeSkills}
        mode="edit"
        onCancel={() => setEditing(false)}
        routine={routine}
      />
    );
  }

  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-primary">
            {routine.name}
          </p>
          <p className="mt-1 line-clamp-2 text-[12px] leading-4 text-ink">
            {routine.prompt}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <Badge className={routine.enabled ? 'text-primary' : 'text-muted'}>
            {routine.enabled ? 'live' : 'paused'}
          </Badge>
          <Badge>{routine.delivery}</Badge>
          <Badge className={routine.consecutiveFailures ? 'text-accent' : ''}>
            {routine.consecutiveFailures} fail
          </Badge>
        </div>
      </div>
      <div className="mt-2 grid gap-1.5 font-mono text-[10px] text-muted md:grid-cols-[1fr_1fr]">
        <span className="truncate">
          {scheduleLabel(routine)} · next {timeOrNever(routine.nextRunAt)}
        </span>
        <span className="truncate">
          last {lastRunLabel(routine)} · {routine.runCount} runs
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] text-muted">
        <span className="min-w-0 truncate">
          {routine.skills.length > 0
            ? `skills ${routine.skills.join(', ')}`
            : routine.scopeRepoId || routine.scopeCwd || routine.createdBy}
        </span>
        <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {routine.lastRun?.reportId ? (
            <a
              className="border border-line px-2 py-1 text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
              href={`/reports/${encodeURIComponent(routine.lastRun.reportId)}`}
              rel="noreferrer"
              target="_blank"
            >
              report
            </a>
          ) : null}
          <Button
            className="min-h-[28px] bg-transparent px-2 py-1 text-[10px] text-muted"
            disabled={
              runMutation.isPending ||
              Boolean(routine.runningRunId) ||
              !routinesEnabled
            }
            onClick={() => runMutation.mutate()}
            title={mutationTitle(
              runMutation.error,
              routine.runningRunId,
              routinesEnabled,
            )}
            type="button"
          >
            {runMutation.isPending ? 'running' : 'run'}
          </Button>
          <Button
            className="min-h-[28px] bg-transparent px-2 py-1 text-[10px] text-muted"
            disabled={enabledMutation.isPending}
            onClick={() => enabledMutation.mutate()}
            title={
              enabledMutation.error
                ? queryErrorMessage(enabledMutation.error)
                : undefined
            }
            type="button"
          >
            {enabledMutation.isPending
              ? routine.enabled
                ? 'pausing'
                : 'resuming'
              : routine.enabled
                ? 'pause'
                : 'resume'}
          </Button>
          <Button
            className="min-h-[28px] bg-transparent px-2 py-1 text-[10px] text-muted"
            disabled={Boolean(routine.runningRunId)}
            onClick={() => setEditing(true)}
            type="button"
          >
            edit
          </Button>
          <Button
            className="min-h-[28px] bg-transparent px-2 py-1 text-[10px] text-muted hover:border-accent hover:text-accent"
            disabled={deleteMutation.isPending || Boolean(routine.runningRunId)}
            onClick={() => setConfirmDelete(true)}
            title={
              deleteMutation.error
                ? queryErrorMessage(deleteMutation.error)
                : undefined
            }
            type="button"
          >
            delete
          </Button>
        </span>
      </div>
      {confirmDelete ? (
        <div className="mt-2 border border-accent/50 bg-field px-2 py-1.5 font-mono text-[10px] text-muted">
          <div className="flex items-center justify-between gap-2">
            <span className="text-accent">Delete routine?</span>
            <span className="flex gap-1.5">
              <Button
                className="min-h-[28px] border-accent bg-transparent px-2 py-1 text-[10px] text-accent"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
                type="button"
              >
                confirm
              </Button>
              <Button
                className="min-h-[28px] bg-transparent px-2 py-1 text-[10px] text-muted"
                disabled={deleteMutation.isPending}
                onClick={() => setConfirmDelete(false)}
                type="button"
              >
                cancel
              </Button>
            </span>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function RoutineForm({
  activeSkills,
  mode,
  onCancel,
  routine,
}: {
  activeSkills: RuntimeSkill[];
  mode: 'create' | 'edit';
  onCancel: (() => void) | null;
  routine: RoutineListItem | null;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<RoutineFormState>(() =>
    routine ? formFromRoutine(routine) : emptyForm,
  );
  const selectedSkills = useMemo(() => new Set(form.skills), [form.skills]);
  const activeSkillIds = useMemo(
    () => new Set(activeSkills.map((skill) => skill.id)),
    [activeSkills],
  );
  const unavailableSelectedSkills = form.skills.filter(
    (skill) => !activeSkillIds.has(skill),
  );
  const mutation = useMutation({
    mutationFn: () =>
      routine
        ? updateRoutine(routine.id, formPayload(form))
        : createRoutine(formPayload(form)),
    onSuccess() {
      if (!routine) setForm(emptyForm);
      onCancel?.();
      void queryClient.invalidateQueries({ queryKey: queryKeys.routines });
    },
  });
  const error = mutation.error ? queryErrorMessage(mutation.error) : null;

  return (
    <form
      className="border border-line bg-field px-2.5 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-2 font-mono text-[10px] tracking-[0.12em] text-muted">
        <span className="text-primary">
          {mode === 'create' ? 'NEW ROUTINE' : 'EDIT ROUTINE'}
        </span>
        {error ? (
          <span className="min-w-0 truncate text-accent">{error}</span>
        ) : null}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <Field label="name">
          <input
            className={inputClassName}
            maxLength={96}
            onChange={(event) =>
              setForm((current) => ({ ...current, name: event.target.value }))
            }
            required
            value={form.name}
          />
        </Field>
        <div className="grid grid-cols-[0.8fr_1fr] gap-2">
          <Field label="type">
            <select
              className={inputClassName}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  scheduleKind: event.target.value as RoutineScheduleKind,
                }))
              }
              value={form.scheduleKind}
            >
              <option value="interval">interval</option>
              <option value="once">once</option>
              <option value="cron">cron</option>
            </select>
          </Field>
          <Field label="schedule">
            <input
              className={inputClassName}
              maxLength={120}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  schedule: event.target.value,
                }))
              }
              placeholder={schedulePlaceholder(form.scheduleKind)}
              required
              value={form.schedule}
            />
          </Field>
        </div>
        <Field label="delivery">
          <select
            className={inputClassName}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                delivery: event.target.value as RoutineDelivery,
              }))
            }
            value={form.delivery}
          >
            <option value="notification">notification</option>
            <option value="report">report</option>
            <option value="session">session</option>
          </select>
        </Field>
        <Field label="repeat">
          <input
            className={inputClassName}
            min={1}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                repeatLimit: event.target.value,
              }))
            }
            placeholder="forever"
            type="number"
            value={form.repeatLimit}
          />
        </Field>
        <Field label="repo">
          <input
            className={inputClassName}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                scopeRepoId: event.target.value,
              }))
            }
            placeholder="repo id"
            value={form.scopeRepoId}
          />
        </Field>
        <Field label="cwd">
          <input
            className={inputClassName}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                scopeCwd: event.target.value,
              }))
            }
            placeholder="/path/to/workdir"
            value={form.scopeCwd}
          />
        </Field>
      </div>
      <Field className="mt-2" label="prompt">
        <textarea
          className={`${inputClassName} min-h-16 resize-none leading-4`}
          maxLength={8_000}
          onChange={(event) =>
            setForm((current) => ({ ...current, prompt: event.target.value }))
          }
          required
          value={form.prompt}
        />
      </Field>
      <div className="mt-2">
        <div className="mb-1 font-mono text-[10px] text-muted">skills</div>
        {activeSkills.length === 0 && unavailableSelectedSkills.length === 0 ? (
          <MiniEmpty label="No active runtime skills." />
        ) : (
          <div className="max-h-28 overflow-auto border border-line bg-soft p-1">
            {unavailableSelectedSkills.length > 0 ? (
              <div className="mb-1 grid gap-1">
                {unavailableSelectedSkills.map((skill) => (
                  <label
                    className="flex min-w-0 items-center gap-1.5 border border-accent/50 px-1.5 py-1 font-mono text-[10px] text-accent"
                    key={skill}
                    title="Selected skill is not currently active. Uncheck it before saving routine edits."
                  >
                    <input
                      checked
                      className="h-3 w-3 accent-primary"
                      onChange={() =>
                        setForm((current) => ({
                          ...current,
                          skills: toggleSkill(current.skills, skill),
                        }))
                      }
                      type="checkbox"
                    />
                    <span className="min-w-0 flex-1 truncate">{skill}</span>
                    <span>missing</span>
                  </label>
                ))}
              </div>
            ) : null}
            <div className="grid gap-1 sm:grid-cols-2">
              {activeSkills.map((skill) => (
                <label
                  className="flex min-w-0 items-center gap-1.5 px-1.5 py-1 font-mono text-[10px] text-muted"
                  key={skill.id}
                >
                  <input
                    checked={selectedSkills.has(skill.id)}
                    className="h-3 w-3 accent-primary"
                    onChange={() =>
                      setForm((current) => ({
                        ...current,
                        skills: toggleSkill(current.skills, skill.id),
                      }))
                    }
                    type="checkbox"
                  />
                  <span className="truncate">{skill.id}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="mt-2 flex justify-end gap-1.5">
        {onCancel ? (
          <Button
            className="min-h-[28px] bg-transparent px-2 py-1 text-[10px] text-muted"
            disabled={mutation.isPending}
            onClick={onCancel}
            type="button"
          >
            cancel
          </Button>
        ) : null}
        <Button
          className="min-h-[28px] px-2 py-1 text-[10px]"
          disabled={mutation.isPending}
          type="submit"
        >
          {mutation.isPending
            ? 'saving'
            : mode === 'create'
              ? 'create'
              : 'save'}
        </Button>
      </div>
    </form>
  );
}

function Field({
  children,
  className = '',
  label,
}: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="mb-1 block font-mono text-[10px] text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputClassName =
  'h-8 w-full min-w-0 border border-line bg-soft px-2 font-mono text-[11px] text-ink outline-none placeholder:text-muted focus:border-primary focus:ring-1 focus:ring-primary';

function formFromRoutine(routine: RoutineListItem): RoutineFormState {
  return {
    name: routine.name,
    prompt: routine.prompt,
    scheduleKind: routine.scheduleKind,
    schedule: routine.schedule,
    delivery: routine.delivery,
    skills: routine.skills,
    scopeRepoId: routine.scopeRepoId ?? '',
    scopeCwd: routine.scopeCwd ?? '',
    repeatLimit:
      routine.repeatLimit === null ? '' : String(routine.repeatLimit),
  };
}

function formPayload(form: RoutineFormState) {
  const repeatLimit = Number(form.repeatLimit);
  return {
    name: form.name.trim(),
    prompt: form.prompt.trim(),
    scheduleKind: form.scheduleKind,
    schedule: form.schedule.trim(),
    delivery: form.delivery,
    skills: form.skills,
    scopeRepoId: form.scopeRepoId.trim() || null,
    scopeCwd: form.scopeCwd.trim() || null,
    repeatLimit:
      form.repeatLimit.trim() && Number.isFinite(repeatLimit)
        ? repeatLimit
        : null,
  };
}

function toggleSkill(skills: string[], id: string) {
  return skills.includes(id)
    ? skills.filter((skill) => skill !== id)
    : [...skills, id];
}

function schedulePlaceholder(kind: RoutineScheduleKind) {
  if (kind === 'once') return '2026-07-06T14:00:00.000Z';
  if (kind === 'cron') return '0 14 * * 1';
  return '900';
}

function scheduleLabel(routine: RoutineListItem) {
  if (routine.scheduleKind === 'interval') {
    return `every ${durationLabel(Number(routine.schedule) * 1000)}`;
  }
  if (routine.scheduleKind === 'once') return `once ${routine.schedule}`;
  return `cron ${routine.schedule}`;
}

function durationLabel(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return 'n/a';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${minutes}m`;
}

function timeOrNever(value: string | null) {
  return value ? relativeTime(value) : 'never';
}

function lastRunLabel(routine: RoutineListItem) {
  const run = routine.lastRun;
  if (!run)
    return routine.lastRunAt ? relativeTime(routine.lastRunAt) : 'never';
  const detail =
    run.status === 'queued'
      ? 'queued'
      : run.status === 'failed'
        ? 'failed'
        : 'completed';
  return `${detail} ${relativeTime(run.updatedAt)}`;
}

function mutationTitle(
  error: unknown,
  runningRunId: string | null,
  routinesEnabled: boolean,
) {
  if (error) return queryErrorMessage(error);
  if (!routinesEnabled) return 'Routines are disabled by runtime config.';
  if (runningRunId) return 'Routine already has an active run.';
  return undefined;
}
