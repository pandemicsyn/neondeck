// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryRecord, MemoryResponse } from '../api';

type ApiModule = typeof import('../api');

const api = vi.hoisted(() => ({
  archiveMemory: vi.fn<ApiModule['archiveMemory']>(),
  getMemories: vi.fn<ApiModule['getMemories']>(),
  upsertMemory: vi.fn<ApiModule['upsertMemory']>(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  archiveMemory: api.archiveMemory,
  getMemories: api.getMemories,
  upsertMemory: api.upsertMemory,
}));

import {
  MemoryPanelPlugin,
  memoryEditorText,
  parseMemoryEditorValue,
} from './MemoryPanel';

describe('MemoryPanel memory controls', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;
  let storedMemories: MemoryRecord[];

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    storedMemories = [memory()];
    api.getMemories.mockImplementation(async () =>
      memoryResponse(storedMemories),
    );
    api.upsertMemory.mockImplementation(async (input) => {
      const updated = memory({
        value: input.value,
        updatedAt: '2026-07-30T00:01:00.000Z',
      });
      storedMemories = [updated];
      return {
        ok: true,
        action: 'memory_upsert',
        changed: true,
        message: 'Updated durable memory.',
        memory: updated,
      };
    });
    api.archiveMemory.mockImplementation(async () => {
      storedMemories = [];
      return {
        ok: true,
        action: 'memory_archive',
        changed: true,
        message: 'Archived durable memory.',
        memory: memory({ status: 'archived' }),
      };
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('edits a memory inline through the typed upsert API', async () => {
    await renderPanel();

    await act(async () => {
      button('Edit').click();
    });
    const editor = container.querySelector('textarea');
    expect(editor).not.toBeNull();
    expect(document.activeElement).toBe(editor);
    await act(async () => {
      if (!editor) return;
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(editor, 'Corrected guidance.');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      button('Save').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(api.upsertMemory).toHaveBeenCalledWith({
      scope: 'project',
      key: 'review-calibration',
      value: 'Corrected guidance.',
      repoId: 'cloud',
      expectedUpdatedAt: '2026-07-30T00:00:00.000Z',
      reason: 'Edited from the Memory dashboard.',
    });
    expect(container.textContent).toContain('Corrected guidance.');
    expect(document.activeElement).toBe(button('Edit'));
  });

  it('requires inline confirmation before archiving a memory', async () => {
    await renderPanel();

    await act(async () => {
      button('Archive').click();
    });
    expect(api.archiveMemory).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Archive this memory?');

    const confirm = container.querySelector<HTMLButtonElement>(
      '[aria-label="Confirm archive project:review-calibration"]',
    );
    expect(document.activeElement).toBe(confirm);
    await act(async () => {
      confirm?.click();
      await vi.waitFor(() => {
        expect(container.textContent).toContain('No durable memory recorded.');
      });
    });

    expect(api.archiveMemory).toHaveBeenCalledWith('memory-1', {
      expectedUpdatedAt: '2026-07-30T00:00:00.000Z',
    });
    expect(document.activeElement).toBe(
      [...container.querySelectorAll('h3')].find(
        (heading) => heading.textContent === 'DURABLE NOTES',
      ),
    );
  });

  it('keeps the editor open and reports resolved API failures', async () => {
    api.upsertMemory.mockResolvedValueOnce({
      ok: false,
      action: 'memory_learn',
      changed: false,
      message: 'Memory values must not contain credential-like content.',
      errors: ['Memory values must not contain credential-like content.'],
      requires: ['value'],
    });
    await renderPanel();

    await act(async () => {
      button('Edit').click();
    });
    await act(async () => {
      button('Save').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'credential-like content',
    );
  });

  it('cancels stale memory reads and refreshes after a mutation', async () => {
    const cancel = vi.spyOn(queryClient, 'cancelQueries');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await renderPanel();

    await act(async () => {
      button('Archive').click();
    });
    const confirm = container.querySelector<HTMLButtonElement>(
      '[aria-label="Confirm archive project:review-calibration"]',
    );
    await act(async () => {
      confirm?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(cancel).toHaveBeenCalledWith({ queryKey: ['memories'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['memories'] });
  });

  it('restores focus when edit or archive is cancelled', async () => {
    await renderPanel();

    await act(async () => {
      button('Edit').click();
    });
    await act(async () => {
      button('Cancel').click();
    });
    expect(document.activeElement).toBe(button('Edit'));

    await act(async () => {
      button('Archive').click();
    });
    await act(async () => {
      button('Keep').click();
    });
    expect(document.activeElement).toBe(button('Archive'));
  });

  it('keeps the value type captured when editing began', async () => {
    await renderPanel();

    await act(async () => {
      button('Edit').click();
    });
    await act(async () => {
      queryClient.setQueryData<MemoryResponse>(
        ['memories'],
        memoryResponse([
          memory({
            value: { corrected: true },
            updatedAt: '2026-07-30T00:02:00.000Z',
          }),
        ]),
      );
    });

    expect(container.textContent).toContain('Stored as text.');
    expect(container.querySelector('textarea')?.value).toBe(
      'Original guidance.',
    );
  });

  function button(label: string) {
    const match = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
    if (!(match instanceof HTMLButtonElement)) {
      throw new Error(`Missing "${label}" button.`);
    }
    return match;
  }

  async function renderPanel() {
    const Component = MemoryPanelPlugin.Component;
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Component
            config={{ limit: 8 }}
            region={{
              id: 'memory',
              title: 'Memory',
              column: 1,
              row: 1,
              columnSpan: 1,
              rowSpan: 1,
              tabs: [],
            }}
          />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
});

describe('memory editor value handling', () => {
  it('preserves text values and formats JSON values', () => {
    expect(memoryEditorText('plain text')).toBe('plain text');
    expect(memoryEditorText({ enabled: true })).toBe('{\n  "enabled": true\n}');
    expect(parseMemoryEditorValue(' updated ', 'text')).toEqual({
      ok: true,
      value: ' updated ',
    });
    expect(parseMemoryEditorValue('{"enabled":false}', 'json')).toEqual({
      ok: true,
      value: { enabled: false },
    });
  });

  it('rejects invalid JSON without changing the memory', () => {
    expect(parseMemoryEditorValue('{broken', 'json')).toEqual({
      ok: false,
      message: 'Enter valid JSON before saving this memory.',
    });
  });
});

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'memory-1',
    scope: 'project',
    key: 'review-calibration',
    value: 'Original guidance.',
    repoId: 'cloud',
    status: 'active',
    useCount: 0,
    lastUsedAt: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    ...overrides,
  };
}

function memoryResponse(memories: MemoryRecord[]): MemoryResponse {
  return {
    ok: true,
    action: 'memory_list',
    changed: false,
    memories,
    fetchedAt: '2026-07-30T00:00:00.000Z',
  };
}
