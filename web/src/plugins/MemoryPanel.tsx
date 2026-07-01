import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  getMemories,
  upsertMemory,
  type MemoryRecord,
  type MemoryScope,
} from '../api';
import { EmptyState } from '../App';
import { Badge, Button, ScrollArea } from '../components/ui';
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
      queryFn: () => getMemories(),
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
  const currentTask = useMemo(
    () =>
      memories.find(
        (memory) => memory.scope === 'session' && memory.key === 'current-task',
      ),
    [memories],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
        <span className="text-violet">MEMORY</span>
        <Badge>{memories.length} entries</Badge>
      </header>
      <ScrollArea className="flex-1">
        <div className="space-y-2.5 p-3">
          <CurrentTaskForm currentTask={currentTask} />
          <section>
            <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] tracking-[0.12em]">
              <span className="text-primary">DURABLE NOTES</span>
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

function CurrentTaskForm({
  currentTask,
}: {
  currentTask: MemoryRecord | undefined;
}) {
  const queryClient = useQueryClient();
  const remoteValue = memoryPreview(currentTask?.value ?? '');
  const [value, setValue] = useState(remoteValue);
  const [isDirty, setIsDirty] = useState(false);
  const skipSyncForRemoteValue = useRef<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: upsertMemory,
    onSuccess(result) {
      setMessage(result.message);
      skipSyncForRemoteValue.current = remoteValue;
      setIsDirty(false);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.memories }),
        queryClient.invalidateQueries({ queryKey: queryKeys.runtimeStatus }),
        queryClient.invalidateQueries({ queryKey: queryKeys.neonSession }),
      ]);
    },
    onError(cause) {
      setMessage(queryErrorMessage(cause));
    },
  });

  useEffect(() => {
    if (skipSyncForRemoteValue.current === remoteValue) return;
    skipSyncForRemoteValue.current = null;
    if (isDirty || mutation.isPending) return;
    setValue(remoteValue);
  }, [isDirty, mutation.isPending, remoteValue]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    mutation.mutate({
      scope: 'session',
      key: 'current-task',
      value: value.trim(),
    });
  }

  return (
    <form className="border border-line bg-soft px-2.5 py-2" onSubmit={save}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] tracking-[0.12em] text-violet">
          CURRENT TASK
        </p>
        <Button
          className="h-6 border-violet bg-field px-2 py-0 font-mono text-[10px] text-violet"
          disabled={mutation.isPending}
          type="submit"
        >
          {mutation.isPending ? 'saving' : 'save'}
        </Button>
      </div>
      <textarea
        className="mt-2 h-14 w-full resize-none border border-line bg-field px-2 py-1.5 text-[11px] leading-4 text-ink outline-none focus:border-violet"
        onChange={(event) => {
          setIsDirty(true);
          setValue(event.target.value);
        }}
        placeholder="What is Neon focused on right now?"
        value={value}
      />
      <p className="mt-1 line-clamp-2 text-[10.5px] leading-4 text-muted">
        Applies to new agent context after a new session.
      </p>
      {message ? (
        <p className="mt-1 line-clamp-2 text-[10.5px] leading-4 text-muted">
          {message}
        </p>
      ) : null}
    </form>
  );
}

function MemoryRow({ memory }: { memory: MemoryRecord }) {
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {memory.scope}:{memory.key}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {memoryPreview(memory.value)}
          </p>
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
  return JSON.stringify(value);
}

function scopeClass(scope: MemoryScope) {
  if (scope === 'session') return 'border-violet text-violet';
  if (scope === 'project') return 'border-primary text-primary';
  if (scope === 'watch') return 'border-accent text-accent';
  return '';
}

function MiniEmpty({ label }: { label: string }) {
  return (
    <div className="border border-line bg-soft px-2.5 py-2 font-mono text-[10px] text-muted">
      {label}
    </div>
  );
}
