// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { FactoryReleaseCoding } from './FactoryReleaseCoding';
import { codingState } from './FactoryCoding.fixtures';
import { getFactoryCodingState } from '../../api/factory-coding';
vi.mock('../../api/factory-coding', () => ({
  getFactoryCodingState: vi.fn<typeof getFactoryCodingState>(),
}));
let client: QueryClient;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const release = vi.fn<(fingerprint: string) => void>();
const key = ['factory-coding-state'];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(key, codingState());
  vi.mocked(getFactoryCodingState).mockResolvedValue(codingState());
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FactoryReleaseCoding
          label="Release v2"
          disabled={false}
          onRelease={release}
        />
      </QueryClientProvider>,
    ),
  );
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find(
    (item) => item.textContent === text,
  );
  if (!found) throw new Error(`Missing ${text}`);
  return found;
}
function fact(label: string) {
  return [...container.querySelectorAll('dt')].find(
    (item) => item.textContent === label,
  )?.nextElementSibling?.textContent;
}
it('shows every normalized fingerprinted field and submits that exact snapshot', async () => {
  const state = codingState();
  state.config = {
    ...state.config,
    adapter: { id: 'kilo', contractVersion: 1, cliVersion: '7.4.23' },
    executable: '/synthetic/bin/kilo',
    model: 'kilo/synthetic',
    auth: { kind: 'auth-json', env: 'SYNTHETIC_AUTH_JSON' },
    path: '/synthetic/bin:/usr/bin',
    wallTimeMs: 90000,
    maxOutputBytes: 12345,
    repositorySkills: 'native-v1',
  };
  client.setQueryData(key, state);
  await render();
  expect(
    Object.fromEntries(
      [...container.querySelectorAll('dt')].map((item) => [
        item.textContent,
        item.nextElementSibling?.textContent,
      ]),
    ),
  ).toEqual({
    'Automatic coding': 'Enabled',
    'Coding CLI': 'kilo',
    'Adapter contract': '1',
    'CLI version': '7.4.23',
    Executable: '/synthetic/bin/kilo',
    Model: 'kilo/synthetic',
    'Credential kind': 'auth-json',
    'Credential environment reference': 'SYNTHETIC_AUTH_JSON',
    'Executable search PATH': '/synthetic/bin:/usr/bin',
    'Permission profile': 'workspace-write',
    'Attempt time limit': '90000 ms (1.5 minutes)',
    'Output limit': '12345 bytes',
    'Maximum writers': '1',
    'Repository skills': 'Native CLI discovery',
  });
  await act(async () => button('Release v2').click());
  expect(release).toHaveBeenCalledExactlyOnceWith(state.configFingerprint);
});
it('requires explicit review after refresh changes previously hidden settings and never silently switches the fingerprint', async () => {
  await render();
  expect(fact('Repository skills')).toBe('Legacy discovery policy');
  const next = codingState();
  next.configFingerprint = 'd'.repeat(64);
  next.config = {
    ...next.config,
    executable: '/synthetic/bin/replaced',
    auth: { kind: 'api-key', env: 'CHANGED_REFERENCE' },
    path: '/synthetic/path',
    wallTimeMs: 1000,
    maxOutputBytes: 1024,
    repositorySkills: 'native-v1',
  };
  await act(async () => {
    client.setQueryData(key, next);
  });
  await flush();
  expect(button('Release v2').disabled).toBe(true);
  expect(fact('Executable')).toBe('/usr/local/bin/codex');
  expect(fact('Credential environment reference')).toBe('CODEX_API_KEY');
  await act(async () => button('Release v2').click());
  expect(release).not.toHaveBeenCalled();
  await act(async () => button('Review updated execution settings').click());
  expect(fact('Executable')).toBe('/synthetic/bin/replaced');
  expect(fact('Credential environment reference')).toBe('CHANGED_REFERENCE');
  expect(fact('Executable search PATH')).toBe('/synthetic/path');
  expect(fact('Attempt time limit')).toContain('1000 ms');
  expect(fact('Output limit')).toBe('1024 bytes');
  await act(async () => button('Release v2').click());
  expect(release).toHaveBeenCalledExactlyOnceWith(next.configFingerprint);
});
it('keeps default Codex settings explicit and submits a nonnull fingerprint while disabled coding is visible', async () => {
  client.setQueryData(key, codingState(false));
  await render();
  expect(fact('Automatic coding')).toBe('Disabled');
  expect(fact('Coding CLI')).toContain('codex (default');
  expect(fact('CLI version')).toBe('Default Codex version policy; no override');
  await act(async () => button('Release v2').click());
  expect(release).toHaveBeenCalledExactlyOnceWith(
    codingState(false).configFingerprint,
  );
});
it('blocks release during refresh and after failed refresh while retaining the reviewed configuration', async () => {
  let reject: (error: Error) => void = () => {
    throw new Error('Not started');
  };
  vi.mocked(getFactoryCodingState).mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await render();
  await act(async () => button('Refresh execution settings').click());
  await flush();
  expect(button('Release v2').disabled).toBe(true);
  await act(async () => reject(new Error('Synthetic failure')));
  await flush();
  expect(button('Release v2').disabled).toBe(true);
  expect(fact('Executable')).toBe('/usr/local/bin/codex');
  expect(container.textContent).toContain('Coding selection is unavailable');
  expect(release).not.toHaveBeenCalled();
});
it('does not offer release before a validated configuration is available', async () => {
  client.removeQueries({ queryKey: key });
  vi.mocked(getFactoryCodingState).mockImplementation(
    () => new Promise(() => {}),
  );
  await render();
  expect(container.textContent).toContain('Loading release execution settings');
  expect(
    [...container.querySelectorAll('button')].some(
      (item) => item.textContent === 'Release v2',
    ),
  ).toBe(false);
});

it('shows the local auth path in the exact release snapshot without an environment downgrade', async () => {
  const state = codingState();
  state.config.auth = {
    kind: 'codex-local',
    path: '/synthetic/.codex/auth.json',
  };
  client.setQueryData(key, state);
  await render();
  expect(fact('Credential kind')).toBe('codex-local');
  expect(fact('Credential file reference')).toBe('/synthetic/.codex/auth.json');
  expect(fact('Credential environment reference')).toBeUndefined();
  await act(async () => button('Release v2').click());
  expect(release).toHaveBeenCalledWith(state.configFingerprint);
});
