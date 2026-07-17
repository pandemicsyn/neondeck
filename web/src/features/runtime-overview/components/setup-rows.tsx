import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import {
  markNotificationRead,
  resolveExecutionApproval,
  resolveNotification,
  switchChatSession,
  type ExecutionApproval,
  type NotificationRecord,
  type RuntimeStatus,
  type RuntimeStatusCheck,
  type SafetyPolicyEntry,
} from '../../../api';
import { OperationalValue } from '../../../components/OperationalValue';
import { Badge } from '../../../components/ui';
import { queryKeys } from '../../../lib/query';
import { notificationDisplayMessage } from '../../../lib/watch-status';
import { MiniEmpty } from './atoms';
import {
  checkClass,
  executionApprovalClass,
  notificationClass,
  relativeTime,
  setupStep,
  shortPath,
} from '../lib/format';
import type { SetupStep } from '../types';

export function RuntimeSection({
  children,
  count,
  title,
  tone,
}: {
  children: React.ReactNode;
  count: number;
  title: string;
  tone: 'primary' | 'accent' | 'violet';
}) {
  const headingId = useId();
  const toneClass =
    tone === 'primary'
      ? 'text-primary'
      : tone === 'accent'
        ? 'text-accent'
        : 'text-violet';

  return (
    <section aria-labelledby={headingId}>
      <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] tracking-[0.12em]">
        <h3
          className={`m-0 text-[inherit] font-[inherit] ${toneClass}`}
          id={headingId}
        >
          {title}
        </h3>
        <span className="text-muted">{count}</span>
      </div>
      {children}
    </section>
  );
}

export function FirstRunSetup({ checks }: { checks: RuntimeStatusCheck[] }) {
  if (checks.length === 0) {
    return <MiniEmpty label="Setup checks are green." />;
  }

  return (
    <div className="space-y-1.5">
      {checks.map((check) => (
        <SetupStepRow check={check} key={check.id} step={setupStep(check)} />
      ))}
    </div>
  );
}

function SetupStepRow({
  check,
  step,
}: {
  check: RuntimeStatusCheck;
  step: SetupStep;
}) {
  return (
    <article className="border border-accent/60 bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {check.label}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {step.detail}
          </p>
        </div>
        <Badge className={checkClass(check)}>{check.level}</Badge>
      </div>
      <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-muted">
        <span className="min-w-0 flex-1 truncate">{step.action}</span>
        <span className="shrink-0 text-violet">{step.surface}</span>
        <a
          className="shrink-0 border border-line px-1.5 py-0.5 text-muted hover:border-primary hover:text-primary"
          href={step.docsHref}
          rel="noreferrer"
          target="_blank"
        >
          {step.docsLabel}
        </a>
      </div>
      <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
        {check.message}
      </p>
    </article>
  );
}

export function ReadinessRow({ check }: { check: RuntimeStatusCheck }) {
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {check.label}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {check.message}
          </p>
        </div>
        <Badge className={checkClass(check)}>
          {check.ok ? 'ok' : check.level}
        </Badge>
      </div>
    </article>
  );
}

export function FlueErrorRow({
  error,
}: {
  error: RuntimeStatus['lastFlueErrors'][number];
}) {
  return (
    <article className="border border-accent/60 bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {error.title}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {error.message}
          </p>
        </div>
        <Badge className="border-accent text-accent">
          {relativeTime(error.createdAt)}
        </Badge>
      </div>
    </article>
  );
}

export function NotificationRow({
  notification,
  onRefresh,
}: {
  notification: NotificationRecord;
  onRefresh: () => void;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: 'read' | 'resolve') {
    setBusy(true);
    setError(null);
    try {
      if (action === 'read') {
        await markNotificationRead(notification.id);
      } else {
        await resolveNotification(notification.id);
      }
      onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openConversation() {
    const sessionId = notificationSessionId(notification.data);
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await switchChatSession(sessionId);
      if (!result.ok) throw new Error(result.message);
      if (result.state) {
        queryClient.setQueryData(queryKeys.neonSession, result.state);
      }
      await markNotificationRead(notification.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chatSessions }),
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
      ]);
      window.dispatchEvent(
        new CustomEvent('neondeck:focus-chat', {
          detail: { pluginId: 'flue-chat' },
        }),
      );
      onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const sessionId = notificationSessionId(notification.data);

  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {notification.title}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {notificationDisplayMessage(notification)}
          </p>
        </div>
        <Badge className={notificationClass(notification)}>
          {notification.level}
        </Badge>
      </div>
      <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-muted">
        <span className="min-w-0 flex-1 truncate">
          {notification.source ?? 'local'} ·{' '}
          {relativeTime(notification.updatedAt)}
          {notification.occurrenceCount > 1
            ? ` · x${notification.occurrenceCount}`
            : ''}
        </span>
        {!notification.readAt ? (
          <button
            className="shrink-0 border border-line px-1.5 py-0.5 text-muted disabled:opacity-50"
            disabled={busy}
            onClick={() => void run('read')}
            type="button"
          >
            read
          </button>
        ) : null}
        {sessionId ? (
          <button
            className="shrink-0 border border-primary/50 px-1.5 py-0.5 text-primary disabled:opacity-50"
            disabled={busy}
            onClick={() => void openConversation()}
            type="button"
          >
            open
          </button>
        ) : null}
        <button
          className="shrink-0 border border-line px-1.5 py-0.5 text-muted disabled:opacity-50"
          disabled={busy}
          onClick={() => void run('resolve')}
          type="button"
        >
          resolve
        </button>
      </div>
      {error ? (
        <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-4 text-accent">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function notificationSessionId(data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const sessionId = (data as Record<string, unknown>).sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : null;
}

export function SafetyPolicyRow({ entry }: { entry: SafetyPolicyEntry }) {
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {entry.title}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {entry.primitive} · {entry.notes}
          </p>
        </div>
        <Badge
          className={
            entry.class === 'host-execution' ||
            entry.class === 'destructive-mutation'
              ? 'border-accent text-accent'
              : ''
          }
        >
          {entry.requiresConfirmation ? 'confirm' : entry.class}
        </Badge>
      </div>
      <div className="mt-1.5 flex justify-between gap-2 font-mono text-[10px] text-muted">
        <span className="truncate">{entry.id}</span>
        <span className="shrink-0">{entry.auditTarget}</span>
      </div>
    </article>
  );
}

export function ExecutionApprovalRow({
  approval,
  onRefresh,
}: {
  approval: ExecutionApproval;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const detailPreview = [
    approval.backend,
    approval.risk,
    approval.cwd ? shortPath(approval.cwd) : null,
    approval.error,
  ]
    .filter(Boolean)
    .join(' · ');
  const fullDetail = [
    approval.backend,
    approval.risk,
    approval.cwd,
    approval.error,
  ]
    .filter(Boolean)
    .join(' · ');

  async function resolve(
    decision: 'allow-once' | 'allow-session' | 'allow-always' | 'deny',
  ) {
    setBusy(decision);
    setError(null);
    try {
      const result = await resolveExecutionApproval(approval.id, decision);
      if (result.requires?.includes('approvalNudge')) {
        setError(
          `Approval resolved, but requester notification failed: ${
            result.errors?.join('; ') ?? 'unknown error'
          }`,
        );
      }
      onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <OperationalValue
            label={`command for approval ${approval.id}`}
            previewClassName="truncate font-mono text-[11px] text-ink"
            value={approval.command}
          />
          <OperationalValue
            className="mt-0.5"
            label={`details for approval ${approval.id}`}
            preview={detailPreview}
            previewClassName="line-clamp-2 text-[10.5px] leading-4 text-muted"
            value={fullDetail}
          />
        </div>
        <Badge className={executionApprovalClass(approval)}>
          {approval.status}
        </Badge>
      </div>
      <div className="mt-1.5 font-mono text-[10px] text-muted">
        <p className="truncate">
          {approval.status === 'approved' && !approval.usedAt
            ? `approved ${relativeTime(approval.resolvedAt ?? approval.updatedAt)} · not yet used`
            : relativeTime(approval.updatedAt)}
          {approval.exitCode !== null ? ` · exit ${approval.exitCode}` : ''}
        </p>
        {approval.status === 'pending' ? (
          <div className="mt-1.5 flex flex-wrap justify-end gap-1">
            <button
              aria-label={`Allow command once: ${approval.command}`}
              className="shrink-0 border border-line px-1.5 py-0.5 text-muted disabled:opacity-50"
              disabled={!!busy}
              onClick={() => void resolve('allow-once')}
              type="button"
            >
              Allow once
            </button>
            <button
              aria-label={`Allow command for this session: ${approval.command}`}
              className="shrink-0 border border-line px-1.5 py-0.5 text-muted disabled:opacity-50"
              disabled={!!busy}
              onClick={() => void resolve('allow-session')}
              type="button"
            >
              Allow for session
            </button>
            <button
              aria-label={`Always allow command: ${approval.command}`}
              className="shrink-0 border border-line px-1.5 py-0.5 text-muted disabled:opacity-50"
              disabled={!!busy}
              onClick={() => void resolve('allow-always')}
              type="button"
            >
              Always allow
            </button>
            <button
              aria-label={`Deny command: ${approval.command}`}
              className="shrink-0 border border-accent px-1.5 py-0.5 text-accent disabled:opacity-50"
              disabled={!!busy}
              onClick={() => void resolve('deny')}
              type="button"
            >
              Deny
            </button>
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-4 text-accent">
          {error}
        </p>
      ) : null}
    </article>
  );
}
