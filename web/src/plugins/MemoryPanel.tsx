import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { getMemories, type MemoryRecord, type MemoryScope } from '../api';
import { OperationalValue } from '../components/OperationalValue';
import { Badge, EmptyState, MiniEmpty, ScrollArea } from '../components/ui';
import { queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';
import { parsePositiveIntegerConfig } from './config';

type MemoryPanelConfig = {
  limit: number;
};

const memoryPanelDefaultConfig = {
  limit: 8,
};

export const MemoryPanelPlugin = {
  id: 'memory-panel',
  title: 'Memory',
  kind: 'data',
  defaultConfig: memoryPanelDefaultConfig,
  parseConfig: (config) =>
    parsePositiveIntegerConfig(memoryPanelDefaultConfig, config),
  Component({ config }) {
    const { data, error, isLoading } = useQuery({
      queryKey: queryKeys.memories,
      queryFn: ({ signal }) => getMemories({}, { signal }),
      refetchInterval: 30_000,
    });

    if (isLoading) {
      return (
        <EmptyState title="Memory loading" detail="Reading durable notes." />
      );
    }

    if (error) {
      return (
        <EmptyState
          title="Memory unavailable"
          detail={queryErrorMessage(error)}
          tone="alert"
        />
      );
    }

    return <MemoryView limit={config.limit} memories={data?.memories ?? []} />;
  },
} satisfies DisplayPlugin<MemoryPanelConfig>;

function MemoryView({
  limit,
  memories,
}: {
  limit: number;
  memories: MemoryRecord[];
}) {
  const headingId = useId();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
        <h2 className="m-0 text-[inherit] font-[inherit] text-violet">
          MEMORY
        </h2>
        <Badge>{memories.length} entries</Badge>
      </header>
      <ScrollArea className="flex-1">
        <div className="space-y-2.5 p-3">
          <section aria-labelledby={headingId}>
            <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] tracking-[0.12em]">
              <h3
                className="m-0 text-[inherit] font-[inherit] text-primary"
                id={headingId}
              >
                DURABLE NOTES
              </h3>
              <span className="text-muted">{memories.length}</span>
            </div>
            <div className="space-y-1.5">
              {memories.slice(0, limit).map((memory) => (
                <MemoryRow key={memory.id} memory={memory} />
              ))}
              {memories.length === 0 ? (
                <MiniEmpty label="No durable memory recorded." />
              ) : null}
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

function MemoryRow({ memory }: { memory: MemoryRecord }) {
  const value = memoryPreview(memory.value);
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p
            className="truncate font-mono text-[11px] text-ink"
            title={`${memory.scope}:${memory.key}`}
          >
            {memory.scope}:{memory.key}
          </p>
          <OperationalValue
            className="mt-0.5"
            label={`value for memory ${memory.scope}:${memory.key}`}
            previewClassName="line-clamp-2 text-[10.5px] leading-4 text-muted"
            value={value}
          />
        </div>
        <Badge className={scopeClass(memory.scope)}>{memory.scope}</Badge>
      </div>
    </article>
  );
}

function memoryPreview(value: unknown) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) return '';
  return JSON.stringify(value) ?? String(value);
}

function scopeClass(scope: MemoryScope) {
  if (scope === 'local') return 'border-accent text-accent';
  if (scope === 'project') return 'border-primary text-primary';
  return '';
}
