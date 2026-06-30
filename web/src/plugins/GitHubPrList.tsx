import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getGitHubPullRequests,
  getRepoRegistry,
  type GitHubPullRequest,
} from '../api';
import { EmptyState } from '../App';
import { SessionReferenceButton } from '../components/SessionReferenceButton';
import { Badge, ScrollArea } from '../components/ui';
import { configEventTouchesFile, useConfigEvents } from '../lib/config-events';
import { queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';

type GitHubPrListConfig = {
  limit: number;
};

export const GitHubPrListPlugin = {
  id: 'github-pr-list',
  title: 'GitHub PR list',
  kind: 'data',
  defaultConfig: {
    limit: 12,
  },
  Component({ config }) {
    const queryClient = useQueryClient();
    const { data, error, isLoading } = useQuery({
      queryKey: queryKeys.githubPrs,
      queryFn: getGitHubPullRequests,
      refetchInterval: 5 * 60_000,
    });
    const { data: registry } = useQuery({
      queryKey: queryKeys.repoRegistry,
      queryFn: getRepoRegistry,
      refetchInterval: 5 * 60_000,
    });

    useConfigEvents((event) => {
      if (
        event.action === 'config_reload' ||
        configEventTouchesFile(event, 'repos.json')
      ) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.githubPrs });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.repoRegistry,
        });
      }
    });

    const login = data?.login ? `@${data.login}` : '@you';
    const items = data ? data.items.slice(0, config.limit) : [];
    const repoIds = new Map(
      (registry?.repos ?? []).map((repo) => [
        `${repo.github.owner}/${repo.github.name}`,
        repo.id,
      ]),
    );
    const countLabel = data
      ? `${items.length} PR${items.length === 1 ? '' : 's'} · ${data.repos?.length ?? 0} REPOS`
      : 'OPEN PRs';

    return (
      <div className="terminal-list flex h-full min-h-0 flex-col">
        <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3.5 font-mono text-[11px] tracking-[0.14em]">
          <span className="flex items-center gap-2 text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            GITHUB · {login}
          </span>
          <span className="text-muted">{countLabel}</span>
        </header>
        {isLoading ? <PrSkeleton /> : null}
        {error ? (
          <EmptyState
            title="GitHub unavailable"
            detail={`${queryErrorMessage(error)}. Set GITHUB_TOKEN in .env to show authored, assigned, and review-requested PRs.`}
          />
        ) : null}
        {data && items.length === 0 ? (
          <EmptyState
            title="Inbox zero"
            detail="Authored, assigned, and review-requested PRs are clear."
          />
        ) : null}
        {data && items.length > 0 ? (
          <ScrollArea className="flex-1">
            <ul>
              {items.map((item) => (
                <li
                  key={item.url}
                  className="pr-row px-3.5 py-2 last:border-b-0"
                >
                  <div className="group">
                    <div className="mb-1 flex items-center justify-between gap-3 font-mono text-[10.5px] text-muted">
                      <span className="truncate">{item.repo}</span>
                      <span className="shrink-0">
                        #{item.number} · {relativeTime(item.updatedAt)}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-[13px] font-medium leading-[1.35] text-ink group-hover:text-primary-strong">
                      {item.title}
                    </p>
                    <div className="mt-1.5 flex items-center gap-2.5 font-mono text-[10px] text-primary">
                      <span className={checkClass(item)}>
                        ● {checkLabel(item)}
                      </span>
                      <span className="text-violet">
                        ◆ {relationLabel(item)}
                      </span>
                      {item.stale ? (
                        <span className="text-accent">◇ stale</span>
                      ) : null}
                      {item.draft || item.labels.includes('draft') ? (
                        <span className="text-muted">△ draft</span>
                      ) : null}
                    </div>
                    {item.labels.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {item.labels.slice(0, 3).map((label) => (
                          <Badge key={label}>{label}</Badge>
                        ))}
                      </div>
                    ) : null}
                    <div className="mt-1.5 flex justify-end gap-1.5 font-mono text-[10px]">
                      <SessionReferenceButton
                        kind="repo"
                        label="session"
                        linkedRepoId={repoIds.get(item.repo) ?? null}
                        linkedTaskId={`github-pr:${item.repo}#${item.number}`}
                        summary={`${item.repo}#${item.number}: ${item.title}. ${checkLabel(item)}; relation ${relationLabel(item)}.`}
                        title={`PR ${item.repo}#${item.number}`}
                        uiMetadata={{
                          source: 'github-pr',
                          repo: item.repo,
                          prNumber: item.number,
                          url: item.url,
                          state: item.state,
                          checks: item.checks?.status ?? null,
                          relations: item.relations,
                        }}
                      />
                      <a
                        className="shrink-0 border border-line px-1.5 py-0.5 text-muted hover:border-primary hover:text-primary"
                        href={item.url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        open
                      </a>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </ScrollArea>
        ) : null}
      </div>
    );
  },
} satisfies DisplayPlugin<GitHubPrListConfig>;

function PrSkeleton() {
  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="border border-line bg-soft p-2">
          <div className="h-3 w-4/5 rounded-sm bg-soft" />
          <div className="mt-2 h-2 w-3/5 rounded-sm bg-soft" />
        </div>
      ))}
    </div>
  );
}

function relativeTime(value: string) {
  const delta = Date.now() - Date.parse(value);
  const hours = Math.max(1, Math.round(delta / 3_600_000));
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function checkLabel(item: GitHubPullRequest) {
  if (item.checkError) return 'checks unknown';
  if (!item.checks) return 'checks unknown';
  if (item.checks.status === 'success') return 'checks pass';
  if (item.checks.status === 'failure') return `${item.checks.failed} failed`;
  if (item.checks.status === 'pending') return `${item.checks.pending} pending`;
  return 'no checks';
}

function checkClass(item: GitHubPullRequest) {
  if (item.checks?.status === 'failure') return 'text-accent';
  if (item.checks?.status === 'pending') return 'text-violet';
  if (item.checks?.status === 'success') return 'text-primary';
  return 'text-muted';
}

function relationLabel(item: GitHubPullRequest) {
  if (item.relations.includes('review-requested')) return 'review requested';
  if (item.relations.includes('assigned')) return 'assigned';
  if (item.relations.includes('authored')) return 'authored';
  return `${item.comments || 0} comments`;
}
