import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getPrWatches, type PrWatch } from '../api';
import { Badge, Button, ScrollArea } from '../components/ui';
import { configEventTouchesFile, useConfigEvents } from '../lib/config-events';
import { queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';

type ActiveWatchesConfig = {
  limit: number;
};

export const ActiveWatchesPlugin = {
  id: 'active-watches',
  title: 'Active watches',
  kind: 'data',
  defaultConfig: {
    limit: 8,
  },
  Component({ config }) {
    const queryClient = useQueryClient();
    const { data, error, isLoading } = useQuery({
      queryKey: queryKeys.prWatches,
      queryFn: getPrWatches,
      refetchInterval: 30_000,
    });

    useConfigEvents((event) => {
      if (
        event.action === 'config_reload' ||
        configEventTouchesFile(event, 'repos.json') ||
        configEventTouchesFile(event, 'schedules.json')
      ) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.prWatches });
      }
    });

    const watches = data?.watches ?? [];
    const visible = watches.slice(0, config.limit);

    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
          <span className="text-primary">WATCHES</span>
          <Badge>{watches.length}</Badge>
        </header>
        <ScrollArea className="flex-1">
          <div className="space-y-2 p-3">
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
              visible.map((watch) => <WatchRow key={watch.id} watch={watch} />)
            )}
          </div>
        </ScrollArea>
      </div>
    );
  },
} satisfies DisplayPlugin<ActiveWatchesConfig>;

function WatchRow({ watch }: { watch: PrWatch }) {
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
        </div>
        <Badge className={statusClass(watch.status)}>{watch.status}</Badge>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] text-muted">
        <span>until {watch.desiredTerminalState}</span>
        {watch.url ? (
          <Button
            className="h-5 border-line bg-transparent px-1.5 py-0 text-[10px] text-muted"
            onClick={() => window.open(watch.url ?? undefined, '_blank')}
            type="button"
          >
            open
          </Button>
        ) : null}
      </div>
    </article>
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
  if (status === 'green') return 'border-primary text-primary';
  if (status === 'attention-needed' || status === 'closed') {
    return 'border-accent text-accent';
  }
  return '';
}
