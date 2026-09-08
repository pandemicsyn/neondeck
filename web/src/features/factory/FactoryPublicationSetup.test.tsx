// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryPublicationSetup } from './FactoryPublicationSetup';
let container: HTMLDivElement;
let root: Root;
const saved = vi.fn<() => Promise<unknown>>();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  saved.mockResolvedValue(undefined);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function render() {
  act(() =>
    root.render(
      <FactoryPublicationSetup
        repoId="registered-repo"
        workId="task-demo"
        disabled={false}
        onSaved={saved}
      />,
    ),
  );
}
async function submit() {
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
it('uses the registered repository and existing credential reference without intake or numeric ID input', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        publication: [
          {
            repoId: 'registered-repo',
            repositoryId: '1234',
            tokenEnv: 'GITHUB_TOKEN',
          },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );
  render();
  await submit();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(
    '/api/factory-delivery/publication-setup/registered-repo',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ tokenEnv: 'GITHUB_TOKEN' }),
    }),
  );
  expect(container.querySelectorAll('input')).toHaveLength(1);
  expect(container.querySelector('a')?.getAttribute('href')).toBe(
    '/factory?task=task-demo',
  );
  expect(container.textContent).toContain('Publication setup saved');
  expect(saved).toHaveBeenCalledOnce();
});
it('retains the credential reference and displays a safe failed setup response for retry', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({ error: 'Credential reference is unavailable.' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ),
  );
  render();
  await submit();
  expect(container.querySelector('input')?.value).toBe('GITHUB_TOKEN');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Credential reference is unavailable',
  );
  expect(container.querySelector('button')?.disabled).toBe(false);
});
