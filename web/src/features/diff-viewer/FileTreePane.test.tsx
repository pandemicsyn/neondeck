// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileTreePane,
  fileReviewMapDecoration,
  fileReviewMapStatusLabel,
} from './FileTreePane';
import type { DiffFilePatch, FileReviewMapEntry } from './types';

describe('FileTreePane review map', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders compact text and a full accessible status label', () => {
    const entry = reviewEntry({
      draftCount: 3,
      findingCount: 2,
      highestFindingSeverity: 'critical',
      staleDraftCount: 1,
      unresolvedThreadCount: 4,
    });

    expect(fileReviewMapDecoration(entry)).toBe('T4 D3 S1 N2 critical');
    expect(fileReviewMapStatusLabel(entry, true)).toBe(
      'src/a.ts: 4 unresolved review threads, 3 local drafts, 1 stale draft, 2 Neon findings, highest severity critical.',
    );
  });

  it('updates review counts without replacing Pierre selection state', async () => {
    const onSelectPath = vi.fn<(path: string) => void>();
    const files = reviewFiles();
    const initialMap = new Map([
      ['src/a.ts', reviewEntry({ unresolvedThreadCount: 1 })],
    ]);

    await act(async () => {
      root.render(
        <FileTreePane
          files={files}
          onSelectPath={onSelectPath}
          reviewMapByPath={initialMap}
          selectedPath="src/a.ts"
        />,
      );
    });

    expect(selectedPaths()).toEqual(['src/a.ts']);
    expect(decorationText('src/a.ts')).toBe('T1');
    expect(container.textContent).toContain(
      'src/a.ts: 1 unresolved review thread.',
    );

    const updatedMap = new Map([
      ['src/a.ts', reviewEntry({ draftCount: 2, unresolvedThreadCount: 1 })],
    ]);
    await act(async () => {
      root.render(
        <FileTreePane
          files={files}
          onSelectPath={onSelectPath}
          reviewMapByPath={updatedMap}
          selectedPath="src/a.ts"
        />,
      );
    });

    expect(selectedPaths()).toEqual(['src/a.ts']);
    expect(decorationText('src/a.ts')).toBe('T1 D2');
    expect(container.textContent).toContain(
      'src/a.ts: 1 unresolved review thread, 2 local drafts.',
    );

    await act(async () => {
      treeItem('src/b.ts')?.click();
    });
    expect(onSelectPath).toHaveBeenCalledWith('src/b.ts');
  });

  it('shares Pierre search state with review navigation, including previous paths', async () => {
    const onFilterChange =
      vi.fn<(query: string | null, paths: string[] | null) => void>();
    const onSelectPath = vi.fn<(path: string) => void>();
    const files = reviewFiles();
    files[0]!.previousPath = 'src/old-a.ts';

    await act(async () => {
      root.render(
        <FileTreePane
          files={files}
          filterQuery="old-a"
          onFilterChange={onFilterChange}
          onSelectPath={onSelectPath}
          selectedPath="src/a.ts"
        />,
      );
    });

    expect(onFilterChange).toHaveBeenLastCalledWith('old-a', ['src/a.ts']);
    expect(treeItem('src/old-a.ts')).not.toBeNull();
    expect(treeItem('src/a.ts')).toBeNull();
    expect(selectedPaths()).toEqual(['src/old-a.ts']);
    expect(decorationText('src/old-a.ts')).toBe('renamed → src/a.ts');
    await act(async () => treeItem('src/old-a.ts')?.click());
    expect(onSelectPath).toHaveBeenCalledWith('src/a.ts');

    const input = searchInput();
    expect(input).not.toBeNull();
    await act(async () => {
      if (!input) return;
      input.value = 'src/b';
      input.dispatchEvent(
        new Event('input', { bubbles: true, composed: true }),
      );
    });
    expect(onFilterChange).toHaveBeenLastCalledWith('src/b', ['src/b.ts']);

    await act(async () => {
      root.render(
        <FileTreePane
          files={files}
          filterQuery={null}
          onFilterChange={onFilterChange}
          onSelectPath={vi.fn<(path: string) => void>()}
          selectedPath="src/a.ts"
        />,
      );
    });
    await act(async () => Promise.resolve());
    expect(onFilterChange).toHaveBeenLastCalledWith(null, null);
  });

  function treeHost() {
    return container.querySelector('file-tree-container');
  }

  function treeItem(path: string) {
    return treeHost()?.shadowRoot?.querySelector<HTMLButtonElement>(
      `[data-item-path="${path}"]`,
    );
  }

  function searchInput() {
    return treeHost()?.shadowRoot?.querySelector<HTMLInputElement>('input');
  }

  function selectedPaths() {
    return [
      ...(treeHost()?.shadowRoot?.querySelectorAll('[data-item-selected]') ??
        []),
    ]
      .map((item) => item.getAttribute('data-item-path'))
      .filter(Boolean);
  }

  function decorationText(path: string) {
    return treeItem(path)
      ?.querySelector('[data-item-section="decoration"]')
      ?.textContent?.trim();
  }
});

function reviewFiles(): DiffFilePatch[] {
  return ['src/a.ts', 'src/b.ts'].map((path) => ({
    additions: 1,
    deletions: 1,
    path,
    status: 'modified',
  }));
}

function reviewEntry(
  overrides: Partial<Omit<FileReviewMapEntry, 'path'>> = {},
): FileReviewMapEntry {
  return {
    draftCount: 0,
    findingCount: 0,
    highestFindingSeverity: null,
    path: 'src/a.ts',
    staleDraftCount: 0,
    unresolvedThreadCount: 0,
    ...overrides,
  };
}
