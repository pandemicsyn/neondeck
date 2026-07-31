import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  archiveMemory,
  getMemories,
  upsertMemory,
  type MemoryRecord,
  type MemoryResponse,
  type MemoryScope,
} from '../api';
import { OperationalValue } from '../components/OperationalValue';
import {
  Badge,
  Button,
  EmptyState,
  MiniEmpty,
  ScrollArea,
  Textarea,
} from '../components/ui';
import { queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';
import { parsePositiveIntegerConfig } from './config';

type MemoryPanelConfig = {
  limit: number;
};

type MemoryEditorValueKind = 'text' | 'json';

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
  const headingRef = useRef<HTMLHeadingElement>(null);
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
                ref={headingRef}
                tabIndex={-1}
              >
                DURABLE NOTES
              </h3>
              <span className="text-muted">{memories.length}</span>
            </div>
            <div className="space-y-1.5">
              {memories.slice(0, limit).map((memory) => (
                <MemoryRow
                  key={memory.id}
                  memory={memory}
                  onArchiveFocusExit={() => headingRef.current?.focus()}
                />
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

function MemoryRow({
  memory,
  onArchiveFocusExit,
}: {
  memory: MemoryRecord;
  onArchiveFocusExit: () => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'view' | 'edit' | 'archive'>('view');
  const [editorValue, setEditorValue] = useState(() =>
    memoryEditorText(memory.value),
  );
  const [editorValueKind, setEditorValueKind] = useState<MemoryEditorValueKind>(
    () => memoryEditorValueKind(memory.value),
  );
  const [editorRevision, setEditorRevision] = useState(memory.updatedAt);
  const [archiveRevision, setArchiveRevision] = useState(memory.updatedAt);
  const [editorError, setEditorError] = useState<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const archiveButtonRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const confirmArchiveRef = useRef<HTMLButtonElement>(null);
  const focusReturnTarget = useRef<'edit' | 'archive' | null>(null);
  const value = memoryPreview(memory.value);
  const mutationSettled = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.memories }),
      queryClient.invalidateQueries({ queryKey: queryKeys.learningState }),
      queryClient.invalidateQueries({ queryKey: queryKeys.runtimeStatus }),
    ]);
  };
  const editMutation = useMutation({
    mutationFn: async (input: {
      nextValue: unknown;
      expectedUpdatedAt: string;
    }) => {
      const result = await upsertMemory({
        scope: memory.scope,
        key: memory.key,
        value: input.nextValue,
        ...(memory.repoId ? { repoId: memory.repoId } : {}),
        expectedUpdatedAt: input.expectedUpdatedAt,
        reason: 'Edited from the Memory dashboard.',
      });
      if (!result.ok) throw new Error(result.message);
      return result;
    },
    async onMutate() {
      await queryClient.cancelQueries({ queryKey: queryKeys.memories });
    },
    onSuccess(result) {
      if (result.memory) {
        updateMemoryCache(queryClient, result.memory);
      } else {
        void queryClient.invalidateQueries({ queryKey: queryKeys.memories });
      }
      setEditorError(null);
      returnToView('edit');
    },
    onSettled: mutationSettled,
  });
  const archiveMutation = useMutation({
    mutationFn: async () => {
      const result = await archiveMemory(memory.id, {
        expectedUpdatedAt: archiveRevision,
      });
      if (!result.ok) throw new Error(result.message);
      return result;
    },
    async onMutate() {
      await queryClient.cancelQueries({ queryKey: queryKeys.memories });
    },
    onSuccess() {
      onArchiveFocusExit();
      queryClient.setQueryData<MemoryResponse>(queryKeys.memories, (current) =>
        current
          ? {
              ...current,
              memories: current.memories.filter(
                (candidate) => candidate.id !== memory.id,
              ),
            }
          : current,
      );
    },
    onSettled: mutationSettled,
  });
  const pending = editMutation.isPending || archiveMutation.isPending;
  const mutationError = editMutation.error ?? archiveMutation.error;

  useEffect(() => {
    if (mode === 'edit') {
      editorRef.current?.focus();
      return;
    }
    if (mode === 'archive') {
      confirmArchiveRef.current?.focus();
      return;
    }
    const target = focusReturnTarget.current;
    focusReturnTarget.current = null;
    if (target === 'edit') editButtonRef.current?.focus();
    if (target === 'archive') archiveButtonRef.current?.focus();
  }, [mode]);

  function returnToView(target: 'edit' | 'archive') {
    focusReturnTarget.current = target;
    setMode('view');
  }

  function beginEdit() {
    editMutation.reset();
    archiveMutation.reset();
    setEditorError(null);
    setEditorValue(memoryEditorText(memory.value));
    setEditorValueKind(memoryEditorValueKind(memory.value));
    setEditorRevision(memory.updatedAt);
    setMode('edit');
  }

  function submitEdit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseMemoryEditorValue(editorValue, editorValueKind);
    if (!parsed.ok) {
      setEditorError(parsed.message);
      return;
    }
    setEditorError(null);
    editMutation.mutate({
      nextValue: parsed.value,
      expectedUpdatedAt: editorRevision,
    });
  }

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
      {mode === 'edit' ? (
        <form className="mt-2" onSubmit={submitEdit}>
          <label
            className="mb-1 block font-mono text-[10px] text-muted"
            htmlFor={`memory-editor-${memory.id}`}
          >
            Memory value
          </label>
          <div className="border border-line bg-field px-2 py-1.5 focus-within:border-primary">
            <Textarea
              aria-describedby={`memory-editor-hint-${memory.id}`}
              className="min-h-24 w-full font-mono text-[10.5px] leading-4"
              disabled={pending}
              id={`memory-editor-${memory.id}`}
              onChange={(event) => setEditorValue(event.target.value)}
              ref={editorRef}
              value={editorValue}
            />
          </div>
          <p
            className="mt-1 text-[10px] leading-4 text-muted"
            id={`memory-editor-hint-${memory.id}`}
          >
            {editorValueKind === 'text'
              ? 'Stored as text.'
              : 'Stored as JSON; the edited value must remain valid JSON.'}
          </p>
          <div className="mt-1.5 flex items-center gap-1.5">
            <Button
              className="h-7 px-2 py-0 font-mono text-[10px]"
              disabled={pending}
              type="submit"
            >
              {editMutation.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button
              className="h-7 px-2 py-0 font-mono text-[10px]"
              disabled={pending}
              onClick={() => returnToView('edit')}
              type="button"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : mode === 'archive' ? (
        <fieldset className="mt-2 min-w-0 border border-accent/40 bg-field px-2 py-1.5">
          <legend className="sr-only">
            Archive memory {memory.scope}:{memory.key}
          </legend>
          <p className="text-[10.5px] leading-4 text-ink">
            Archive this memory? It will stop loading in new sessions, while its
            audit history remains available.
          </p>
          <div className="mt-1.5 flex items-center gap-1.5">
            <Button
              aria-label={`Confirm archive ${memory.scope}:${memory.key}`}
              className="h-7 border-accent/50 px-2 py-0 font-mono text-[10px] text-accent hover:border-accent hover:text-accent"
              disabled={pending}
              onClick={() => archiveMutation.mutate()}
              ref={confirmArchiveRef}
              type="button"
            >
              {archiveMutation.isPending ? 'Archiving…' : 'Archive'}
            </Button>
            <Button
              className="h-7 px-2 py-0 font-mono text-[10px]"
              disabled={pending}
              onClick={() => returnToView('archive')}
              type="button"
            >
              Keep
            </Button>
          </div>
        </fieldset>
      ) : (
        <div className="mt-1.5 flex items-center gap-1.5">
          <Button
            className="h-7 px-2 py-0 font-mono text-[10px]"
            onClick={beginEdit}
            ref={editButtonRef}
            type="button"
          >
            Edit
          </Button>
          <Button
            className="h-7 px-2 py-0 font-mono text-[10px] text-muted hover:border-accent hover:text-accent"
            onClick={() => {
              editMutation.reset();
              archiveMutation.reset();
              setEditorError(null);
              setArchiveRevision(memory.updatedAt);
              setMode('archive');
            }}
            ref={archiveButtonRef}
            type="button"
          >
            Archive
          </Button>
        </div>
      )}
      {editorError || mutationError ? (
        <p className="mt-1.5 text-[10px] leading-4 text-accent" role="alert">
          {editorError ?? queryErrorMessage(mutationError)}
        </p>
      ) : null}
    </article>
  );
}

function updateMemoryCache(
  queryClient: ReturnType<typeof useQueryClient>,
  memory: MemoryRecord,
) {
  queryClient.setQueryData<MemoryResponse>(queryKeys.memories, (current) =>
    current
      ? {
          ...current,
          memories: current.memories.map((candidate) =>
            candidate.id === memory.id ? memory : candidate,
          ),
        }
      : current,
  );
}

export function memoryEditorText(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function memoryEditorValueKind(value: unknown): MemoryEditorValueKind {
  return typeof value === 'string' ? 'text' : 'json';
}

export function parseMemoryEditorValue(
  value: string,
  valueKind: MemoryEditorValueKind,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (valueKind === 'text') {
    return { ok: true, value };
  }
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return {
      ok: false,
      message: 'Enter valid JSON before saving this memory.',
    };
  }
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
