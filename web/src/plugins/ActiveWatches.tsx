import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import {
  approvePrAutopilotChange,
  getPrWatches,
  configurePrAutopilot,
  controlPrAutopilot,
  messagePrAutopilotOwner,
  type PrWatch,
  type PrWatchMutationResponse,
} from '../api';
import { Badge, Button, ScrollArea } from '../components/ui';
import { FlueChatSessionView } from '../features/flue-chat/components/session-view';
import { configEventTouchesFile, useConfigEvents } from '../lib/config-events';
import { relativeTime } from '../lib/format';
import { queryErrorMessage, queryKeys } from '../lib/query';
import {
  isCompletedPrWatch,
  prWatchAttentionReason,
} from '../lib/watch-status';
import type { DisplayPlugin } from '../types';
import {
  WorktreeDiffReview,
  type WorktreeDiffReviewState,
} from '../features/diff-viewer/surfaces';
import { parsePositiveIntegerConfig } from './config';

type ActiveWatchesConfig = {
  limit: number;
};

export type PrWatchStopOutcome = Pick<
  PrWatchMutationResponse,
  'message' | 'detachedWorktreeId' | 'cleanupRecovery'
> & {
  watchId: string;
};

const activeWatchesDefaultConfig = {
  limit: 8,
};

export const ActiveWatchesPlugin = {
  id: 'active-watches',
  title: 'Active watches',
  kind: 'data',
  defaultConfig: activeWatchesDefaultConfig,
  parseConfig: (config) =>
    parsePositiveIntegerConfig(activeWatchesDefaultConfig, config),
  Component({ config }) {
    const queryClient = useQueryClient();
    const [stopOutcome, setStopOutcome] = useState<PrWatchStopOutcome | null>(
      null,
    );
    const { data, error, isLoading } = useQuery({
      queryKey: queryKeys.prWatches,
      queryFn: getPrWatches,
      refetchInterval: 30_000,
    });

    useConfigEvents((event) => {
      if (
        event.action === 'config_reload' ||
        configEventTouchesFile(event, 'repos.json')
      ) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
      }
    });

    const watches = activePrWatches(data?.watches ?? []);
    const visible = watches.slice(0, config.limit);

    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
          <span className="text-primary">WATCHES</span>
          <Badge>{watches.length}</Badge>
        </header>
        <ScrollArea className="flex-1">
          <div className="space-y-2 p-3">
            {stopOutcome ? (
              <StopOutcomeNotice
                onDismiss={() => setStopOutcome(null)}
                outcome={stopOutcome}
              />
            ) : null}
            {isLoading ? (
              <WatchState
                title="Loading watches"
                detail="Reading runtime state."
              />
            ) : error ? (
              <WatchState
                title="Watch API failed"
                detail={queryErrorMessage(error)}
              />
            ) : visible.length === 0 ? (
              <WatchState
                title="No active watches"
                detail="PR watches will appear here after they are created."
              />
            ) : (
              visible.map((watch) => (
                <WatchRow
                  key={watch.id}
                  onStopOutcome={setStopOutcome}
                  watch={watch}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    );
  },
} satisfies DisplayPlugin<ActiveWatchesConfig>;

export function activePrWatches(watches: PrWatch[]) {
  return watches.filter((watch) => !isCompletedPrWatch(watch));
}

export function WatchRow({
  watch,
  onStopOutcome,
}: {
  watch: PrWatch;
  onStopOutcome?: (outcome: PrWatchStopOutcome) => void;
}) {
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [confirmingMode, setConfirmingMode] = useState<
    PrWatch['autopilotMode'] | null
  >(null);
  const [reviewingDiff, setReviewingDiff] = useState(false);
  const [reviewingOwner, setReviewingOwner] = useState(false);
  const [confirmingApproval, setConfirmingApproval] = useState(false);
  const [reviewedRevisionKey, setReviewedRevisionKey] = useState<string | null>(
    null,
  );
  const queryClient = useQueryClient();
  const stopMutation = useMutation({
    mutationFn: () =>
      controlPrAutopilot(watch.id, 'stop', { confirmPreparedDiff: true }),
    onSuccess(result) {
      onStopOutcome?.({
        watchId: watch.id,
        message: result.message,
        detachedWorktreeId: result.detachedWorktreeId,
        cleanupRecovery: result.cleanupRecovery,
      });
      setConfirmingStop(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.autopilotState,
      });
    },
  });
  const pollingEnabled = watch.pollingEnabled !== false;
  const pollingMutation = useMutation({
    mutationFn: () =>
      controlPrAutopilot(watch.id, pollingEnabled ? 'pause' : 'resume'),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
    },
  });
  const checkedLabel = watch.lastCheckedAt
    ? `checked ${relativeTime(watch.lastCheckedAt)}`
    : 'not checked';
  const nextPollLabel = !pollingEnabled
    ? 'polling paused'
    : watch.nextRunAt
      ? `next ${relativeTime(watch.nextRunAt)}`
      : 'next poll pending';
  const sourceLabel = watch.createdBy ? ` · ${watch.createdBy}` : '';
  const activityLabel = `activity ${relativeTime(
    watch.lastSnapshot?.updatedAt ?? watch.updatedAt,
  )}`;
  const attentionReason = prWatchAttentionReason(watch);
  const reviewLabel = reviewDecisionLabel(watch.lastSnapshot?.reviewDecision);
  const mergedChecksPending =
    watch.lastSnapshot?.merged === true &&
    watch.lastSnapshot.checks?.status === 'pending';
  const configureMutation = useMutation({
    mutationFn: (input: { mode: PrWatch['autopilotMode']; confirm: boolean }) =>
      configurePrAutopilot({
        ref: watch.id,
        mode: input.mode,
        processExisting: watch.processExisting,
        confirm: input.confirm,
      }),
    onSuccess() {
      setConfirmingMode(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.autopilotState,
      });
    },
  });
  const retryMutation = useMutation({
    mutationFn: () => controlPrAutopilot(watch.id, 'retry'),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
    },
  });
  const ownerMessageMutation = useMutation({
    mutationFn: (message: string) => messagePrAutopilotOwner(watch.id, message),
    onSuccess() {
      setConfirmingApproval(false);
      setReviewingOwner(true);
      void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.autopilotState,
      });
    },
  });
  const approvalMutation = useMutation({
    mutationFn: (expectedRevisionKey: string) =>
      approvePrAutopilotChange(watch.id, expectedRevisionKey),
    onSuccess() {
      setConfirmingApproval(false);
      setReviewingOwner(true);
      void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.autopilotState,
      });
    },
    onError() {
      setConfirmingApproval(false);
      setReviewedRevisionKey(null);
      void queryClient.invalidateQueries({
        queryKey: ['diff-viewer', 'repo-diff'],
      });
    },
  });
  const handleDiffReviewState = useCallback(
    (state: WorktreeDiffReviewState) => {
      setConfirmingApproval(false);
      setReviewedRevisionKey(
        state.status === 'reviewable' ? state.revisionKey : null,
      );
    },
    [],
  );
  const approvalAvailable =
    watch.autopilotMode === 'autofix-with-approval' &&
    watch.autopilotStatus === 'waiting' &&
    Boolean(
      watch.ownerInstanceId &&
      watch.worktreeId &&
      watch.worktreeHeadSha &&
      reviewedRevisionKey,
    );
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-primary">
            {watch.repoFullName}#{watch.prNumber}
          </p>
          <p className="mt-1 line-clamp-2 text-[12px] leading-4 text-ink">
            {watch.title ?? 'Untitled PR'}
          </p>
          {attentionReason ? (
            <p className="mt-1 font-mono text-[10px] leading-4 text-accent">
              why · {attentionReason}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge
            className={
              mergedChecksPending
                ? 'border-warn text-warn'
                : statusClass(watch.status)
            }
          >
            {mergedChecksPending ? 'merged · checks pending' : watch.status}
          </Badge>
          {watch.autopilotStatus !== 'watching' ? (
            <Badge className={autopilotStatusClass(watch.autopilotStatus)}>
              {watch.autopilotStatus}
            </Badge>
          ) : null}
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-muted">
        <span>mode</span>
        <select
          aria-label={`Autopilot mode for ${watch.id}`}
          className="min-h-[28px] min-w-0 flex-1 border border-line bg-field px-2 text-[10px] text-ink"
          disabled={configureMutation.isPending}
          onChange={(event) => {
            const mode = event.target.value as PrWatch['autopilotMode'];
            if (
              autopilotModeRank(mode) > autopilotModeRank(watch.autopilotMode)
            ) {
              setConfirmingMode(mode);
              return;
            }
            setConfirmingMode(null);
            configureMutation.mutate({ mode, confirm: false });
          }}
          value={watch.autopilotMode}
        >
          <option value="notify-only">Notify only · no coding</option>
          <option value="prepare-only">Prepare commit · never push</option>
          <option value="autofix-with-approval">
            Prepare commit · push after approval
          </option>
          <option value="autofix-push-when-safe">
            Autonomous judgment + delivery
          </option>
        </select>
      </div>
      {confirmingMode ? (
        <div className="mt-2 border border-accent/50 bg-field px-2 py-1.5 font-mono text-[10px] text-muted">
          <p className="text-accent">
            Increase Autopilot authority to {confirmingMode}?
          </p>
          <p className="mt-1 leading-4">{autopilotModeHelp(confirmingMode)}</p>
          <span className="mt-1.5 flex gap-1.5">
            <Button
              className="min-h-[28px] border-accent bg-transparent px-2 py-1 text-[10px] text-accent"
              disabled={configureMutation.isPending}
              onClick={() =>
                configureMutation.mutate({
                  mode: confirmingMode,
                  confirm: true,
                })
              }
              type="button"
            >
              confirm increase
            </Button>
            <Button
              className="min-h-[28px] bg-transparent px-2 py-1 text-[10px] text-muted"
              disabled={configureMutation.isPending}
              onClick={() => setConfirmingMode(null)}
              type="button"
            >
              cancel
            </Button>
          </span>
          {configureMutation.error ? (
            <p className="mt-1 text-accent">
              {queryErrorMessage(configureMutation.error)}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] text-muted">
        <span className="min-w-0 truncate">
          until {watch.desiredTerminalState}
          {reviewLabel ? ` · ${reviewLabel}` : ''} · {checkedLabel} ·{' '}
          {nextPollLabel}
          {' · '}
          {activityLabel}
          {sourceLabel}
        </span>
        <span className="flex shrink-0 gap-1.5">
          {watch.ownerInstanceId ? (
            <Button
              aria-label={`Review owner agent for ${watch.repoFullName} pull request ${watch.prNumber}`}
              className="min-h-[28px] border-primary bg-transparent px-2 py-1 text-[10px] text-primary"
              onClick={() => setReviewingOwner((current) => !current)}
              title={`Open continuing owner ${watch.ownerInstanceId}`}
              type="button"
            >
              {reviewingOwner ? 'hide agent' : 'review agent'}
            </Button>
          ) : null}
          {watch.url ? (
            <Button
              className="min-h-[28px] border-line bg-transparent px-2 py-1 text-[10px] text-muted"
              onClick={() =>
                window.open(
                  watch.url ?? undefined,
                  '_blank',
                  'noopener,noreferrer',
                )
              }
              type="button"
            >
              open
            </Button>
          ) : null}
          <Button
            className="min-h-[28px] border-line bg-transparent px-2 py-1 text-[10px] text-muted"
            disabled={pollingMutation.isPending}
            onClick={() => pollingMutation.mutate()}
            title={
              pollingMutation.error
                ? queryErrorMessage(pollingMutation.error)
                : undefined
            }
            type="button"
          >
            {pollingMutation.isPending
              ? pollingEnabled
                ? 'pausing'
                : 'resuming'
              : pollingEnabled
                ? 'pause'
                : 'resume'}
          </Button>
          {watch.autopilotStatus === 'blocked' ? (
            <Button
              className="min-h-[28px] border-accent bg-transparent px-2 py-1 text-[10px] text-accent"
              disabled={retryMutation.isPending}
              onClick={() => retryMutation.mutate()}
              type="button"
            >
              {retryMutation.isPending ? 'retrying' : 'retry'}
            </Button>
          ) : null}
          {watch.worktreeId && watch.worktreeHeadSha ? (
            <Button
              className="min-h-[28px] border-primary bg-transparent px-2 py-1 text-[10px] text-primary"
              onClick={() => {
                setReviewedRevisionKey(null);
                setConfirmingApproval(false);
                setReviewingDiff((current) => !current);
              }}
              type="button"
            >
              {reviewingDiff ? 'hide diff' : 'review diff'}
            </Button>
          ) : null}
          <Button
            className="min-h-[28px] border-line bg-transparent px-2 py-1 text-[10px] text-muted hover:border-accent hover:text-accent"
            disabled={stopMutation.isPending || pollingMutation.isPending}
            onClick={() => setConfirmingStop(true)}
            type="button"
          >
            stop
          </Button>
        </span>
      </div>
      {confirmingStop ? (
        <div className="mt-2 border border-accent/50 bg-field px-2 py-1.5 font-mono text-[10px] text-muted">
          <div className="flex items-start justify-between gap-2">
            <span className="text-accent">
              Stop this Autopilot watch? Eligible Neondeck-managed worktrees
              will be deleted. If one holds an unpushed prepared commit, this
              confirms that you reviewed and want to discard it.
            </span>
            <span className="flex gap-1.5">
              <Button
                className="min-h-[28px] border-accent bg-transparent px-2 py-1 text-[10px] text-accent"
                disabled={stopMutation.isPending}
                onClick={() => stopMutation.mutate()}
                type="button"
              >
                confirm
              </Button>
              <Button
                className="min-h-[28px] bg-transparent px-2 py-1 text-[10px] text-muted"
                disabled={stopMutation.isPending}
                onClick={() => setConfirmingStop(false)}
                type="button"
              >
                cancel
              </Button>
            </span>
          </div>
          {stopMutation.error ? (
            <p className="mt-1 text-accent">
              {queryErrorMessage(stopMutation.error)}
            </p>
          ) : null}
        </div>
      ) : null}
      {reviewingDiff && watch.worktreeId && watch.worktreeHeadSha ? (
        <div className="mt-2 border border-line bg-field">
          <div className="max-h-[28rem] overflow-auto">
            <WorktreeDiffReview
              base={watch.worktreeHeadSha}
              detail={`${watch.autopilotMode} · ${watch.autopilotStatus}`}
              onReviewStateChange={handleDiffReviewState}
              repoId={watch.repoId}
              title={`${watch.repoFullName}#${watch.prNumber} Autopilot change`}
              worktreeId={watch.worktreeId}
            />
          </div>
          {approvalAvailable ? (
            <div className="border-t border-line bg-panel px-2.5 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="max-w-[62ch] text-[10.5px] leading-4 text-muted">
                  Approving sends a direct human instruction to this PR owner.
                  Push authority and current-branch guards are checked again
                  before delivery.
                </p>
                <Button
                  className="min-h-[28px] shrink-0 border-primary bg-transparent px-2 py-1 font-mono text-[10px] text-primary"
                  disabled={approvalMutation.isPending}
                  onClick={() => setConfirmingApproval(true)}
                  type="button"
                >
                  approve &amp; push
                </Button>
              </div>
              {confirmingApproval ? (
                <div className="mt-2 border border-primary/60 bg-field px-2 py-1.5 font-mono text-[10px] text-muted">
                  <p className="text-primary">
                    Approve this prepared commit and ask the owner to push it to
                    the linked PR branch?
                  </p>
                  <div className="mt-1.5 flex gap-1.5">
                    <Button
                      className="min-h-[28px] border-primary bg-transparent px-2 py-1 text-[10px] text-primary"
                      disabled={approvalMutation.isPending}
                      onClick={() =>
                        reviewedRevisionKey
                          ? approvalMutation.mutate(reviewedRevisionKey)
                          : undefined
                      }
                      type="button"
                    >
                      {approvalMutation.isPending
                        ? 'sending approval'
                        : 'confirm approval'}
                    </Button>
                    <Button
                      className="min-h-[28px] bg-transparent px-2 py-1 text-[10px] text-muted"
                      disabled={approvalMutation.isPending}
                      onClick={() => setConfirmingApproval(false)}
                      type="button"
                    >
                      cancel
                    </Button>
                  </div>
                  {approvalMutation.error ? (
                    <p className="mt-1 text-accent">
                      {queryErrorMessage(approvalMutation.error)}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {reviewingOwner && watch.ownerInstanceId ? (
        <div className="mt-2 flex h-[28rem] min-h-0 flex-col overflow-hidden border border-line bg-field">
          <FlueChatSessionView
            activeRecord={undefined}
            agentName="pr-autopilot-owner"
            allowCommands={false}
            key={`pr-autopilot-owner:${watch.ownerInstanceId}`}
            messageEnabled={
              watch.autopilotMode === 'autofix-with-approval' &&
              watch.autopilotStatus === 'waiting'
            }
            messageLabel={`Message owner for ${watch.repoFullName} pull request ${watch.prNumber}`}
            onSendMessage={async (message) => {
              await ownerMessageMutation.mutateAsync(message);
            }}
            quickCommands={[]}
            session={{
              id: watch.ownerInstanceId,
              label: `PR owner ${watch.prNumber}`,
              placeholder:
                watch.autopilotMode === 'autofix-with-approval' &&
                watch.autopilotStatus === 'waiting'
                  ? 'ask for one more focused edit or request discard'
                  : 'Owner messages are available while approval mode is waiting.',
            }}
            sessionState={undefined}
          />
        </div>
      ) : null}
    </article>
  );
}

export function StopOutcomeNotice({
  outcome,
  onDismiss,
}: {
  outcome: PrWatchStopOutcome;
  onDismiss: () => void;
}) {
  const retained = Boolean(outcome.cleanupRecovery);
  return (
    <div
      className={`border bg-field px-2 py-2 font-mono text-[10px] leading-4 ${
        retained ? 'border-accent/70 text-accent' : 'border-primary/60 text-ink'
      }`}
      role={retained ? 'alert' : 'status'}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">
            {retained ? 'Worktree retained for recovery' : 'Autopilot stopped'}
          </p>
          <p className="mt-1 text-muted">
            {outcome.cleanupRecovery ?? outcome.message}
          </p>
          {outcome.detachedWorktreeId ? (
            <p className="mt-1 text-ink">
              Recovery worktree: {outcome.detachedWorktreeId}
            </p>
          ) : null}
        </div>
        <Button
          aria-label={`Dismiss stop outcome for ${outcome.watchId}`}
          className="min-h-[24px] bg-transparent px-1.5 py-0.5 text-[9px] text-muted"
          onClick={onDismiss}
          type="button"
        >
          dismiss
        </Button>
      </div>
    </div>
  );
}

function WatchState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-32 flex-col items-center justify-center text-center">
      <div className="miami-accent mb-2 h-1 w-10" />
      <p className="text-[12px] font-semibold text-ink">{title}</p>
      <p className="mt-1 max-w-[24ch] text-[11px] leading-4 text-muted">
        {detail}
      </p>
    </div>
  );
}

function statusClass(status: string) {
  if (status === 'green' || status === 'ready')
    return 'border-primary text-primary';
  if (status === 'attention-needed') return 'border-accent text-accent';
  if (status === 'closed' || status === 'merged')
    return 'border-line text-muted';
  return '';
}

function reviewDecisionLabel(
  decision: NonNullable<PrWatch['lastSnapshot']>['reviewDecision'],
) {
  switch (decision) {
    case 'APPROVED':
      return 'review approved';
    case 'CHANGES_REQUESTED':
      return 'changes requested';
    case 'REVIEW_REQUIRED':
      return 'review required';
    default:
      return null;
  }
}

function autopilotStatusClass(status: PrWatch['autopilotStatus']) {
  if (status === 'blocked') return 'border-accent text-accent';
  if (status === 'working' || status === 'waiting')
    return 'border-warn text-warn';
  if (status === 'complete') return 'border-primary text-primary';
  return 'border-line text-muted';
}

function autopilotModeRank(mode: PrWatch['autopilotMode']) {
  return [
    'notify-only',
    'prepare-only',
    'autofix-with-approval',
    'autofix-push-when-safe',
  ].indexOf(mode);
}

function autopilotModeHelp(mode: PrWatch['autopilotMode']) {
  switch (mode) {
    case 'notify-only':
      return 'Reports meaningful changes without starting a coding turn.';
    case 'prepare-only':
      return 'Codes, validates, and commits locally for your review; it cannot push or respond to the PR.';
    case 'autofix-with-approval':
      return 'Does the same work, then waits for Review diff → Approve & push. Owner chat can guide edits or discard the held change, but cannot authorize delivery.';
    case 'autofix-push-when-safe':
      return 'Delegates semantic engineering judgment: the owner validates proportionately and may push/respond when it judges the change sound.';
  }
}
