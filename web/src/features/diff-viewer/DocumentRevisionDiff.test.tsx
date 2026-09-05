// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const renderDiff = vi.hoisted(() => vi.fn());
vi.mock('@pierre/diffs/react', () => ({
  FileDiff: (props: unknown) => {
    renderDiff(props);
    return <div>Rendered diff</div>;
  },
}));
vi.mock('./DiffViewer', () => ({
  DiffWorkerProvider: ({ children }: { children: React.ReactNode }) => children,
  useResolvedDiffTheme: () => 'dark',
}));
vi.mock('@pierre/diffs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pierre/diffs')>();
  return { ...actual, parseDiffFromFile: vi.fn(actual.parseDiffFromFile) };
});
import * as pierre from '@pierre/diffs';
import { DocumentRevisionDiff } from './DocumentRevisionDiff';
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  root = createRoot(container);
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
});
function render(a: string, b: string) {
  act(() =>
    root.render(
      <DocumentRevisionDiff
        before={{ id: 'v1', label: 'v1', text: a }}
        after={{ id: 'v2', label: 'v2', text: b }}
      />,
    ),
  );
}
it('uses real Pierre document parsing for changed criteria without a PR source', () => {
  render(
    '# Criteria\n- [ac-1] Match titles',
    '# Criteria\n- [ac-1] Match case-insensitively',
  );
  expect(renderDiff).toHaveBeenCalledWith(
    expect.objectContaining({
      fileDiff: expect.objectContaining({ name: 'brief.md' }),
    }),
  );
  expect(container.textContent).toContain('v1 → v2');
});
it('handles same-version and two empty documents without invoking the renderer', () => {
  render('', '');
  expect(container.textContent).toContain('No document changes');
  render('same', 'same');
  expect(renderDiff).not.toHaveBeenCalled();
});
it('preserves readable documents when comparison fails', () => {
  vi.mocked(pierre.parseDiffFromFile).mockImplementationOnce(() => {
    throw new Error('Synthetic parse failure');
  });
  render('old text', 'new text');
  expect(container.querySelector('[role=alert]')!.textContent).toContain(
    'Comparison unavailable',
  );
  expect(container.textContent).toContain('old text');
  expect(container.textContent).toContain('new text');
});
