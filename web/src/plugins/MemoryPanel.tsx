import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  getMemories,
  upsertMemory,
  type MemoryRecord,
  type MemoryResponse,
  type MemoryScope,
} from '../api';
import { EmptyState } from '../App';
import { Badge, Button, ScrollArea } from '../components/ui';
import type { DisplayPlugin } from '../types';

type MemoryPanelConfig = {
  limit: number;
};

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; response: MemoryResponse };

export const MemoryPanelPlugin = {
  id: 'memory-panel',
  title: 'Memory',
  kind: 'data',
  defaultConfig: {
    limit: 8,
  },
  Component({ config }) {
    const [state, setState] = useState<State>({ status: 'loading' });
    const [refreshKey, setRefreshKey] = useState(0);

    useEffect(() => {
      let cancelled = false;

      async function load() {
        try {
          const response = await getMemories();
          if (!cancelled) setState({ status: 'ready', response });
        } catch (cause) {
          if (!cancelled) {
            setState({
              status: 'error',
              message: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
      }

      void load();
      const timer = window.setInterval(load, 30_000);
      return () => {
        cancelled = true;
        window.clearInterval(timer);
      };
    }, [refreshKey]);

    if (state.status === 'loading') {
      return (
        <EmptyState title="Memory loading" detail="Reading durable notes." />
      );
    }

    if (state.status === 'error') {
      return <EmptyState title="Memory unavailable" detail={state.message} />;
    }

    return (
      <MemoryView
        limit={config.limit}
        memories={state.response.memories}
        onRefresh={() => setRefreshKey((value) => value + 1)}
      />
    );
  },
} satisfies DisplayPlugin<MemoryPanelConfig>;

function MemoryView({
  limit,
  memories,
  onRefresh,
}: {
  limit: number;
  memories: MemoryRecord[];
  onRefresh: () => void;
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
          <CurrentTaskForm currentTask={currentTask} onRefresh={onRefresh} />
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
  onRefresh,
}: {
  currentTask: MemoryRecord | undefined;
  onRefresh: () => void;
}) {
  const [value, setValue] = useState(memoryPreview(currentTask?.value ?? ''));
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(memoryPreview(currentTask?.value ?? ''));
  }, [currentTask]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const result = await upsertMemory({
        scope: 'session',
        key: 'current-task',
        value: value.trim(),
      });
      setMessage(result.message);
      onRefresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="border border-line bg-soft px-2.5 py-2" onSubmit={save}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] tracking-[0.12em] text-violet">
          CURRENT TASK
        </p>
        <Button
          className="h-6 border-violet bg-field px-2 py-0 font-mono text-[10px] text-violet"
          disabled={saving}
          type="submit"
        >
          {saving ? 'saving' : 'save'}
        </Button>
      </div>
      <textarea
        className="mt-2 h-14 w-full resize-none border border-line bg-field px-2 py-1.5 text-[11px] leading-4 text-ink outline-none focus:border-violet"
        onChange={(event) => setValue(event.target.value)}
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
