// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryDraftRecovery } from './FactoryDraftRecovery';
let container: HTMLDivElement;
let root: Root;
const blobs: Blob[] = [];
const create = vi.fn((blob: Blob) => {
  blobs.push(blob);
  return `blob:recovery-${blobs.length}`;
});
const revoke = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  blobs.length = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(raw: string | null) {
  const finish = () => root.render(null);
  await act(async () =>
    root.render(
      <StrictMode>
        <FactoryDraftRecovery
          recovery={{ status: 'failed', raw, error: 'Invalid draft' }}
          onRetry={finish}
          onDiscard={finish}
        />
      </StrictMode>,
    ),
  );
}
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Expected text'));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}
function link() {
  return container.querySelector('a');
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => button.click());
}
it('exports a large retained draft as an exact Blob and keeps the live URL until replacement/unmount', async () => {
  const raw = 'Δraft 😀\r\n% & + # '.repeat(160_000);
  await render(raw);
  expect(link()?.getAttribute('href')).toMatch(/^blob:/);
  expect(link()?.getAttribute('download')).toBe('factory-draft-recovery.txt');
  const first = link()?.getAttribute('href');
  expect(await readBlob(blobs[blobs.length - 1])).toBe(raw);
  expect(revoke).not.toHaveBeenCalledWith(first);
  await render(raw);
  expect(link()?.getAttribute('href')).toBe(first);
  expect(revoke).not.toHaveBeenCalledWith(first);
  await render('Replacement\r\nexact text');
  expect(revoke).toHaveBeenCalledWith(first);
  const second = link()?.getAttribute('href');
  expect(second).not.toBe(first);
  expect(await readBlob(blobs[blobs.length - 1])).toBe(
    'Replacement\r\nexact text',
  );
  await act(async () => root.render(null));
  expect(revoke).toHaveBeenCalledWith(second);
  expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual(
    create.mock.results.map((r) => r.value).sort(),
  );
});
it('releases replaced data when the new failed read has no retained text', async () => {
  await render('Retained');
  const url = link()?.getAttribute('href');
  await render(null);
  expect(link()).toBeNull();
  expect(revoke).toHaveBeenCalledWith(url);
});
it.each(['retry', 'discard'])(
  'releases the URL when successful %s ends recovery',
  async (mode) => {
    await render('Retained');
    const url = link()?.getAttribute('href');
    if (mode === 'retry') await click('Retry draft recovery');
    else {
      await click('Discard saved draft…');
      expect(revoke).not.toHaveBeenCalledWith(url);
      await click('Confirm discard saved draft');
    }
    expect(link()).toBeNull();
    expect(revoke).toHaveBeenCalledWith(url);
  },
);
