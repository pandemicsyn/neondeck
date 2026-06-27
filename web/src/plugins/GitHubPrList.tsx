import { useEffect, useState } from 'react';
import { getGitHubPullRequests, type GitHubPullRequest } from '../api';
import { EmptyState } from '../App';
import { Badge, ScrollArea } from '../components/ui';
import type { DisplayPlugin } from '../types';

type GitHubPrListConfig = {
  limit: number;
};

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      login?: string;
      repos?: string[];
      items: GitHubPullRequest[];
      fetchedAt?: string;
    };

export const GitHubPrListPlugin = {
  id: 'github-pr-list',
  title: 'GitHub PR list',
  kind: 'data',
  defaultConfig: {
    limit: 12,
  },
  Component({ config }) {
    const [state, setState] = useState<State>({ status: 'loading' });

    useEffect(() => {
      let cancelled = false;

      async function load() {
        try {
          const data = await getGitHubPullRequests();
          if (!cancelled) {
            setState({
              status: 'ready',
              login: data.login,
              repos: data.repos,
              items: data.items,
              fetchedAt: data.fetchedAt,
            });
          }
        } catch (cause) {
          if (!cancelled) {
            setState({
              status: 'error',
              message: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
      }

      load();
      const timer = window.setInterval(load, 60_000);
      return () => {
        cancelled = true;
        window.clearInterval(timer);
      };
    }, []);

    const login =
      state.status === 'ready' && state.login ? `@${state.login}` : '@you';
    const items =
      state.status === 'ready' ? state.items.slice(0, config.limit) : [];
    const countLabel =
      state.status === 'ready'
        ? `${items.length} PR${items.length === 1 ? '' : 's'} · ${state.repos?.length ?? 0} REPOS`
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
        {state.status === 'loading' ? <PrSkeleton /> : null}
        {state.status === 'error' ? (
          <EmptyState
            title="GitHub unavailable"
            detail={`${state.message}. Set GITHUB_TOKEN in .env to show authored, assigned, and review-requested PRs.`}
          />
        ) : null}
        {state.status === 'ready' && items.length === 0 ? (
          <EmptyState
            title="Inbox zero"
            detail="Authored, assigned, and review-requested PRs are clear."
          />
        ) : null}
        {state.status === 'ready' && items.length > 0 ? (
          <ScrollArea className="flex-1">
            <ul>
              {items.map((item) => (
                <li
                  key={item.url}
                  className="pr-row px-3.5 py-2 last:border-b-0"
                >
                  <a
                    className="group block"
                    href={item.url}
                    rel="noreferrer"
                    target="_blank"
                  >
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
                      <span>● checks pass</span>
                      <span className="text-violet">
                        ◆ {item.comments || 1} review
                      </span>
                      {item.labels.includes('draft') ? (
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
                  </a>
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
