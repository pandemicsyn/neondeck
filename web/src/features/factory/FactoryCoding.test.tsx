// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryCoding } from './FactoryCoding';
import { FactoryCodingEvidence } from './FactoryCodingEvidence';
import { FactoryCodingSetup } from './FactoryCodingSetup';
import {
  codingRun,
  codingState,
  candidateSummary,
} from './FactoryCoding.fixtures';
import { factoryCodingStateKey } from './FactoryCodingSetup';
import {
  getFactoryCandidateDiff,
  getFactoryCodingRun,
} from '../../api/factory-coding';

vi.mock('../diff-viewer/surfaces', () => ({
  PreparedDiffReview: ({
    diff,
    readOnly,
  }: {
    diff: { id: string };
    readOnly?: boolean;
  }) => (
    <div data-testid="prepared-review">
      {diff.id} {readOnly ? 'read-only' : 'mutable'}
    </div>
  ),
}));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let current = codingRun();
let state = codingState();
let failure = '';
let calls: { url: string; body: unknown }[];
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  current = codingRun();
  state = codingState();
  failure = '';
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (failure && url.includes(failure))
      return response({ error: 'Synthetic request failed' }, 503);
    if (init?.method === 'POST') {
      const body: unknown = JSON.parse(String(init.body));
      calls.push({ url, body });
      if (url.endsWith('/config'))
        return response({ error: 'Settings changed elsewhere' }, 409);
      current = codingRun(url.endsWith('/cancel') ? 'cancelling' : 'running');
      return response(current);
    }
    if (url.endsWith('/state')) return response(state);
    if (url.includes('/runs?'))
      return response({
        items: [{ sequence: 1, run: current }],
        nextCursor: null,
      });
    if (url.includes('/events?'))
      return response({ items: [], nextCursor: null });
    if (url.includes('/logs?'))
      return response({
        text: '<script>untrusted output</script>',
        nextOffset: 30,
        truncated: false,
      });
    if (url.endsWith('/summary')) return response(candidateSummary);
    return response(current);
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.restoreAllMocks();
});
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 35));
  });
}
async function render(
  node: ReactNode = <FactoryCoding workId="work-demo" eligible />,
) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>,
    ),
  );
  await flush();
  await flush();
}
function button(label: string) {
  const element = [...container.querySelectorAll('button')].find(
    (item) => item.textContent === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}
async function click(label: string) {
  await act(async () => button(label).click());
  await flush();
}
function form() {
  const element = container.querySelector('form');
  if (!element) throw new Error('Missing form');
  return element;
}

it('shows loading without action controls', async () => {
  vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}));
  await render();
  expect(container.textContent).toContain('Loading coding attempts');
  expect(container.textContent).not.toContain('Stop coding');
});
it('shows API errors and rejects unknown statuses without enabling controls', async () => {
  vi.mocked(fetch).mockResolvedValue(
    response({ ...current, displayStatus: 'new-unknown-state' }),
  );
  await render();
  expect(container.textContent).toContain(
    'Coding history unavailable or unsupported',
  );
  expect(container.textContent).not.toContain('Stop coding');
});
it('explains disabled coding for a released task without adding a launch action', async () => {
  state = codingState(false);
  vi.mocked(fetch).mockImplementation(async (input) =>
    response(
      String(input).includes('/runs?')
        ? { items: [], nextCursor: null }
        : state,
    ),
  );
  await render();
  expect(container.textContent).toContain('Local coding is disabled');
  expect(container.textContent).not.toContain('Start coding');
});
it.each([
  ['reserved', 'Preparing workspace'],
  ['running', 'Coding in progress'],
  ['collecting', 'Collecting candidate'],
  ['cancelling', 'Stopping coding'],
  ['needs-reconcile', 'Ownership needs reconciliation'],
  ['failed', 'Coding attempt failed'],
  ['cancelled', 'Coding stopped'],
  ['candidate-awaiting-review', 'Coding candidate retained'],
] satisfies [ReturnType<typeof codingRun>['displayStatus'], string][])(
  'renders %s clearly',
  async (status, text) => {
    current = codingRun(status);
    await render();
    expect(container.textContent).toContain(text);
    expect(container.textContent).toContain('session-synthetic-01');
    expect(container.textContent).not.toContain('ownershipToken');
    expect(container.textContent?.includes('Stop coding')).toBe(
      ['reserved', 'running', 'collecting'].includes(status),
    );
  },
);
it('cancels the exact run version and waits for backend cancellation state', async () => {
  await render();
  await click('Stop coding');
  expect(calls).toEqual([
    {
      url: '/api/factory/coding/runs/run-demo/cancel',
      body: { expectedVersion: 3 },
    },
  ]);
  expect(container.textContent).toContain('Stopping coding');
});
it('offers reconciliation, not blind retry, for uncertain ownership', async () => {
  current = codingRun('needs-reconcile');
  await render();
  await click('Reconcile ownership');
  expect(calls[0]).toEqual({
    url: '/api/factory/coding/runs/run-demo/reconcile',
    body: { expectedVersion: 3 },
  });
  expect(container.textContent).not.toContain('Retry coding');
});
it('disables controls on stale run reads while retaining evidence', async () => {
  await render();
  failure = '/runs/run-demo';
  await act(async () => {
    await client.refetchQueries({
      queryKey: ['factory-coding-run', 'run-demo'],
    });
  });
  await flush();
  expect(button('Stop coding').disabled).toBe(true);
  expect(container.textContent).toContain('Displayed evidence may be stale');
  expect(container.textContent).toContain('session-synthetic-01');
});
it('handles failed cancellation without a false stopped state', async () => {
  await render();
  failure = '/cancel';
  await click('Stop coding');
  expect(container.textContent).toContain('Synthetic request failed');
  expect(container.textContent).toContain('Coding in progress');
});
it('uses the real returned prepared diff identity in read-only review', async () => {
  current = codingRun('candidate-awaiting-review');
  await render();
  await click('Review retained worktree');
  expect(
    container.querySelector('[data-testid="prepared-review"]')?.textContent,
  ).toBe('candidate-demo read-only');
  expect(container.textContent).toContain(
    'Current checks, independent review and publication status',
  );
});
it('does not fabricate a diff when collection has no prepared review surface', async () => {
  current = { ...codingRun('candidate-awaiting-review'), diff: null };
  await render();
  expect(container.textContent).toContain('prepared diff is not available yet');
  expect(container.textContent).not.toContain('Review retained worktree');
});
it('retains config and expected fingerprint after optimistic concurrency rejection', async () => {
  await render(<FactoryCodingSetup />);
  await click('Configure coding');
  await act(async () =>
    form().dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ),
  );
  await flush();
  expect(calls[0]?.body).toEqual({
    expectedFingerprint: 'c'.repeat(64),
    config: state.config,
  });
  expect(container.textContent).toContain('Settings changed elsewhere');
  expect(
    container.querySelector('input[name="model"]')?.getAttribute('value'),
  ).toBe('synthetic-codex-model');
});
it('requires explicit reload when the config fingerprint changes while editing', async () => {
  await render(<FactoryCodingSetup />);
  await click('Configure coding');
  state = {
    ...state,
    configFingerprint: 'synthetic-config-v2',
    config: { ...state.config, model: 'updated-model' },
  };
  await act(async () => {
    await client.refetchQueries({ queryKey: factoryCodingStateKey });
  });
  await flush();
  expect(button('Save coding settings').disabled).toBe(true);
  expect(container.textContent).toContain('Your edits are retained');
  await click('Reload current coding settings');
  expect(button('Save coding settings').disabled).toBe(false);
  await act(async () =>
    form().dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ),
  );
  await flush();
  expect(calls[0]?.body).toMatchObject({
    expectedFingerprint: 'synthetic-config-v2',
    config: { model: 'updated-model' },
  });
});
it.each([
  {
    minutes: '0.3333',
    outputMiB: '0.3333',
    wallTimeMs: 19998,
    maxOutputBytes: 349490,
  },
  {
    minutes: '0.333333',
    outputMiB: '0.000977',
    wallTimeMs: 20000,
    maxOutputBytes: 1024,
  },
  {
    minutes: String(1 / 60),
    outputMiB: String(1 / 1024),
    wallTimeMs: 1000,
    maxOutputBytes: 1024,
  },
  {
    minutes: '45',
    outputMiB: '64',
    wallTimeMs: 2700000,
    maxOutputBytes: 67108864,
  },
])(
  'saves $minutes minutes and $outputMiB MiB as bounded integer API units',
  async ({ minutes, outputMiB, wallTimeMs, maxOutputBytes }) => {
    await render(<FactoryCodingSetup />);
    await click('Configure coding');
    for (const [name, value] of Object.entries({ minutes, outputMiB })) {
      const input = container.querySelector<HTMLInputElement>(
        `input[name="${name}"]`,
      );
      if (!input) throw new Error(`Missing ${name} input`);
      input.value = value;
    }
    await act(async () =>
      form().dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      expectedFingerprint: state.configFingerprint,
      config: { ...state.config, wallTimeMs, maxOutputBytes },
    });
  },
);
it.each([
  { name: 'minutes', value: '0.016666' },
  { name: 'minutes', value: '45.000001' },
  { name: 'outputMiB', value: '0.0009765' },
  { name: 'outputMiB', value: '64.0000001' },
  { name: 'minutes', value: '-1' },
  { name: 'outputMiB', value: '0' },
  { name: 'minutes', value: '' },
  { name: 'outputMiB', value: '' },
  { name: 'minutes', value: 'not-a-number' },
  { name: 'outputMiB', value: 'NaN' },
  { name: 'minutes', value: 'Infinity' },
  { name: 'outputMiB', value: '1e309' },
])(
  'rejects invalid $name=$value before rounding can admit it',
  async ({ name, value }) => {
    await render(<FactoryCodingSetup />);
    await click('Configure coding');
    const input = container.querySelector<HTMLInputElement>(
      `input[name="${name}"]`,
    );
    if (!input) throw new Error(`Missing ${name} input`);
    input.value = value;
    // Submit directly to check application validation even without browser constraints.
    await act(async () =>
      form().dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    await flush();
    expect(calls).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'finite limits',
    );
    expect(container.querySelector('form')).not.toBeNull();
  },
);
it('rejects mismatched run and prepared diff identities at IO boundaries', async () => {
  await expect(getFactoryCodingRun('other-run')).rejects.toThrow(
    'does not match',
  );
  await expect(
    getFactoryCandidateDiff('other-diff', 'workspace-demo'),
  ).rejects.toThrow('does not match');
});
it('renders bounded logs as text rather than HTML', async () => {
  await render();
  const details = container.querySelector<HTMLDetailsElement>(
    '.factory-coding-evidence:last-child',
  );
  if (!details) throw new Error('Missing evidence');
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  await flush();
  expect(container.querySelector('pre')?.textContent).toContain(
    '<script>untrusted output</script>',
  );
  expect(container.querySelector('script')).toBeNull();
});

it('saves configured coding only after a successful typed response', async () => {
  const original = vi.mocked(fetch).getMockImplementation();
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (init?.method === 'POST' && String(input).endsWith('/config'))
      return response(state);
    if (!original) throw new Error('Missing fetch fixture');
    return original(input, init);
  });
  await render(<FactoryCodingSetup />);
  await click('Configure coding');
  await act(async () =>
    form().dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ),
  );
  await flush();
  expect(container.querySelector('form')).toBeNull();
  expect(container.textContent).toContain('Configure coding');
});

it('shows the latest run initially and preserves selection through bounded older pages and refresh', async () => {
  let newest = 27;
  const requested: number[] = [];
  const makeRun = (sequence: number) => {
    const run = codingRun(sequence === newest ? 'running' : 'failed');
    return {
      ...run,
      record: {
        ...run.record,
        runId: `run-${sequence}`,
        attemptId: `attempt-${sequence}`,
        providerSessionId: `session-${sequence}`,
      },
    };
  };
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://fixture.local');
    if (url.pathname.endsWith('/state')) return response(state);
    if (url.pathname.endsWith('/runs')) {
      const after = Number(url.searchParams.get('after'));
      requested.push(after);
      const first = after === 0 ? newest : after - 1;
      const last = Math.max(1, first - 24);
      const items = Array.from({ length: first - last + 1 }, (_, index) => {
        const sequence = first - index;
        return { sequence, run: makeRun(sequence) };
      });
      return response({ items, nextCursor: last > 1 ? last : null });
    }
    const id = Number(url.pathname.split('/').at(-1)?.replace('run-', ''));
    return response(makeRun(id));
  });
  await render();
  expect(container.textContent).toContain('session-27');
  expect(container.textContent).toContain('Coding in progress');
  expect(requested).toEqual([0]);
  const select = container.querySelector<HTMLSelectElement>(
    '.factory-coding-attempt-picker select',
  );
  if (!select) throw new Error('Missing attempt selector');
  expect(select.value).toBe('run-27');
  await act(async () => {
    select.value = 'run-3';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
  newest = 28;
  await click('Refresh coding');
  expect(requested).toEqual([0, 0]);
  expect(select.value).toBe('run-3');
  expect(container.textContent).toContain('session-3');
  await click('Load more attempts');
  expect(requested).toEqual([0, 0, 4]);
  expect(select.value).toBe('run-3');
  newest = 29;
  await click('Refresh coding');
  expect(requested).toEqual([0, 0, 4, 0, 5]);
  expect(select.value).toBe('run-3');
  expect(container.textContent).toContain('session-3');
});

it('shows a current admission block without fabricating a run, and clears it after refresh', async () => {
  let blocked = true;
  vi.mocked(fetch).mockImplementation(async (input) => {
    if (String(input).endsWith('/state')) return response(state);
    return response({
      items: [],
      nextCursor: null,
      attention: blocked
        ? {
            workId: 'work-demo',
            inputFingerprint: 'blocked-input-v1',
            reason:
              'The configured default branch was not found. Update the repository configuration.',
            updatedAt: '2026-09-06T12:03:12.000Z',
          }
        : null,
    });
  });
  await render();
  expect(container.textContent).toContain('Coding could not start');
  expect(container.textContent).toContain(
    'The configured default branch was not found',
  );
  expect(container.textContent).not.toContain('awaiting automatic dispatch');
  expect(container.textContent).not.toContain('Stop coding');
  expect(container.textContent).not.toContain('Recorded attempt');
  blocked = false;
  await click('Refresh coding');
  expect(container.textContent).not.toContain('Coding could not start');
  expect(container.textContent).toContain('awaiting automatic dispatch');
});

it('rejects admission attention for a different work item', async () => {
  vi.mocked(fetch).mockResolvedValue(
    response({
      items: [],
      nextCursor: null,
      attention: {
        workId: 'other-work',
        inputFingerprint: 'other-input',
        reason: 'Other task reason',
        updatedAt: '2026-09-06T12:03:12.000Z',
      },
    }),
  );
  await render();
  expect(container.textContent).toContain(
    'Coding history unavailable or unsupported',
  );
  expect(container.textContent).not.toContain('Other task reason');
});

it('selects registered CLIs without saving or executing and clears provider credentials', async () => {
  await render(<FactoryCodingSetup />);
  await click('Configure coding');
  const selector =
    container.querySelector<HTMLSelectElement>('[name="adapter"]');
  if (!selector) throw new Error('Missing adapter selector');
  expect([...selector.options].map((option) => option.text)).toEqual([
    'Codex',
    'OpenCode',
    'Kilo Code',
  ]);
  expect(selector.value).toBe('codex');
  await act(async () => {
    selector.value = 'opencode';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(calls).toEqual([]);
  expect(
    container.querySelector<HTMLInputElement>('[name="authEnv"]')?.value,
  ).toBe('');
  expect(
    container.querySelector<HTMLInputElement>('[name="executable"]')?.value,
  ).toBe('');
  expect(
    container.querySelector<HTMLInputElement>('[name="model"]')?.value,
  ).toBe('');
  expect(
    container.querySelector<HTMLSelectElement>('[name="authKind"]')?.value,
  ).toBe('auth-json');
  expect(container.textContent).toContain(
    'Existing runs and repairs keep their pinned CLI',
  );
});

it.each(['opencode', 'kilo'])(
  'retains edited generic limits and PATH when switching to %s and saving',
  async (adapterId) => {
    await render(<FactoryCodingSetup />);
    await click('Configure coding');
    for (const [name, value] of Object.entries({
      minutes: '2.5',
      outputMiB: '3',
      path: '/synthetic/bin:/usr/bin',
    })) {
      const input = container.querySelector<HTMLInputElement>(
        `input[name="${name}"]`,
      );
      if (!input) throw new Error(`Missing ${name} input`);
      input.value = value;
    }
    const selector =
      container.querySelector<HTMLSelectElement>('[name="adapter"]');
    if (!selector) throw new Error('Missing adapter selector');
    await act(async () => {
      selector.value = adapterId;
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(
      container.querySelector<HTMLInputElement>('[name="executable"]')?.value,
    ).toBe('');
    expect(
      container.querySelector<HTMLInputElement>('[name="model"]')?.value,
    ).toBe('');
    expect(
      container.querySelector<HTMLInputElement>('[name="authEnv"]')?.value,
    ).toBe('');
    expect(calls).toEqual([]);
    await act(async () =>
      form().dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      expectedFingerprint: state.configFingerprint,
      config: {
        ...state.config,
        adapter: {
          id: adapterId,
          contractVersion: 1,
          cliVersion: 'synthetic-version',
        },
        executable: null,
        model: null,
        auth: null,
        path: '/synthetic/bin:/usr/bin',
        wallTimeMs: 150000,
        maxOutputBytes: 3145728,
      },
    });
  },
);

it('saves the explicit adapter contract and version with only a credential reference', async () => {
  await render(<FactoryCodingSetup />);
  await click('Configure coding');
  const selector =
    container.querySelector<HTMLSelectElement>('[name="adapter"]');
  if (!selector) throw new Error('Missing adapter selector');
  await act(async () => {
    selector.value = 'kilo';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const credential =
    container.querySelector<HTMLInputElement>('[name="authEnv"]');
  if (!credential) throw new Error('Missing credential reference');
  credential.value = 'SYNTHETIC_AUTH_REFERENCE';
  await act(async () =>
    form().dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ),
  );
  await flush();
  expect(calls[0]?.body).toMatchObject({
    expectedFingerprint: 'c'.repeat(64),
    config: {
      adapter: {
        id: 'kilo',
        contractVersion: 1,
        cliVersion: 'synthetic-version',
      },
      auth: { kind: 'auth-json', env: 'SYNTHETIC_AUTH_REFERENCE' },
    },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe('/api/factory/coding/config');
});

it('shows selected settings separately from the pinned running CLI', async () => {
  state.config.adapter = {
    id: 'kilo',
    contractVersion: 1,
    cliVersion: 'synthetic-version',
  };
  await render(
    <>
      <FactoryCodingSetup />
      <FactoryCoding workId="work-demo" eligible />
    </>,
  );
  expect(container.textContent).toContain('Selected CLI: Kilo Code');
  expect(container.textContent).toContain('Pinned coding CLIcodex · 0.150.1');
  expect(container.textContent).toContain(
    'does not change this run or its grant',
  );
});

it('shows unsupported selected readiness without claiming the other registered CLIs are unavailable', async () => {
  state.config.adapter = {
    id: 'opencode',
    contractVersion: 1,
    cliVersion: 'synthetic-version',
  };
  state.readiness.ready = false;
  state.readiness.blockers = [
    'The selected OpenCode CLI version is unsupported.',
  ];
  await render(<FactoryCodingSetup />);
  expect(container.textContent).toContain('Selected CLI: OpenCode');
  expect(container.textContent).toContain(
    'The selected OpenCode CLI version is unsupported.',
  );
  expect(container.textContent).not.toContain('Codex is unavailable');
  expect(calls).toEqual([]);
});

it.each([
  ['disabled', 'Disabled'],
  ['unconfigured', 'Needs configuration'],
  ['host-unsupported', 'Operating system unsupported'],
  ['adapter-unavailable', 'Adapter unavailable'],
  ['credential-unavailable', 'Credential reference unavailable'],
  ['executable-unresolved', 'Executable unresolved'],
  ['unsupported', 'CLI contract unsupported'],
  ['ready', 'CLI contract ready'],
  ['busy', 'Readiness check deferred'],
] satisfies [
  NonNullable<ReturnType<typeof codingState>['readiness']['status']>,
  string,
][])(
  'distinguishes %s readiness from live authentication',
  async (status, label) => {
    state.readiness.status = status;
    state.readiness.authentication = 'unverified';
    await render(<FactoryCodingSetup />);
    expect(container.querySelector('.factory-coding-badge')?.textContent).toBe(
      label,
    );
    expect(container.textContent).toContain('Authentication: unverified');
    expect(container.textContent).toContain(
      'Workspace compatibility is checked',
    );
  },
);

it('retains settings and prevents submission after readiness refresh fails', async () => {
  await render(<FactoryCodingSetup />);
  await click('Configure coding');
  failure = '/state';
  await act(async () => {
    await client.refetchQueries({ queryKey: factoryCodingStateKey });
  });
  await flush();
  expect(button('Save coding settings').disabled).toBe(true);
  await act(async () =>
    form().dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ),
  );
  expect(calls).toEqual([]);
  expect(
    container.querySelector<HTMLInputElement>('[name="model"]')?.value,
  ).toBe('synthetic-codex-model');
});

it('refreshes the selected run immediately from Refresh coding', async () => {
  await render();
  current = codingRun('failed');
  await click('Refresh coding');
  expect(container.textContent).toContain('Coding attempt failed');
  expect(container.textContent).not.toContain('Stop coding');
});

it('returns to the previous bounded log page without losing the page position', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://fixture.local');
    if (url.pathname.endsWith('/logs')) {
      const offset = Number(url.searchParams.get('offset'));
      return response({
        text: `Page ${offset}`,
        nextOffset: offset + 100,
        truncated: offset < 200,
      });
    }
    return original(input, init);
  });
  await render();
  const details = container.querySelector<HTMLDetailsElement>(
    '.factory-coding-evidence:last-child',
  )!;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  await flush();
  await click('Next log excerpt');
  await click('Next log excerpt');
  expect(container.querySelector('pre')?.textContent).toBe('Page 200');
  await click('Previous log excerpt');
  expect(container.querySelector('pre')?.textContent).toBe('Page 100');
  expect(button('Previous log excerpt').disabled).toBe(false);
});

it('opens collapsed Factory setup from a released coding blocker', async () => {
  state = codingState(false);
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) =>
    String(input).includes('/runs?')
      ? Promise.resolve(response({ items: [], nextCursor: null }))
      : original(input, init),
  );
  await render(
    <>
      <FactoryCoding workId="work-demo" eligible />
      <details id="factory-setup">
        <summary>Factory setup</summary>
      </details>
    </>,
  );
  await act(async () =>
    container
      .querySelector<HTMLAnchorElement>('a[href="#factory-setup"]')!
      .click(),
  );
  expect(
    container.querySelector<HTMLDetailsElement>('#factory-setup')!.open,
  ).toBe(true);
});

it('preserves local Codex auth when editing unrelated coding settings', async () => {
  state.config.auth = {
    kind: 'codex-local',
    path: '/synthetic/.codex/auth.json',
  };
  await render(<FactoryCodingSetup />);
  await click('Configure coding');
  expect(
    container.querySelector<HTMLSelectElement>('[name="authKind"]')?.value,
  ).toBe('codex-local');
  expect(
    container.querySelector<HTMLInputElement>('[name="authPath"]')?.value,
  ).toBe('/synthetic/.codex/auth.json');
  const model = container.querySelector<HTMLInputElement>('[name="model"]')!;
  model.value = 'synthetic-updated-model';
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(calls).toContainEqual(
    expect.objectContaining({
      body: expect.objectContaining({
        config: expect.objectContaining({
          model: 'synthetic-updated-model',
          auth: { kind: 'codex-local', path: '/synthetic/.codex/auth.json' },
        }),
      }),
    }),
  );
});

it.each(['disabled', 'credential-unavailable'] as const)(
  'shows not checked when %s prevented a version probe',
  async (status) => {
    state.readiness = {
      ...state.readiness,
      status,
      ready: false,
      installedVersion: null,
    };
    await render(<FactoryCodingSetup />);
    expect(container.textContent).toContain('CLI not checked');
    expect(container.textContent).not.toContain('CLI not detected');
  },
);

it('keeps empty unsupported version output distinct from an unperformed check', async () => {
  state.readiness = {
    ...state.readiness,
    status: 'unsupported',
    ready: false,
    installedVersion: null,
  };
  await render(<FactoryCodingSetup />);
  expect(container.textContent).toContain('CLI version unavailable');
  expect(container.textContent).toContain('CLI contract unsupported');
});

it('shows only the selected credential field, retains source drafts, and resets on adapter changes', async () => {
  await render(<FactoryCodingSetup />);
  await click('Configure coding');
  const select = async (name: string, value: string) =>
    act(async () => {
      const field = container.querySelector<HTMLSelectElement>(
        `[name="${name}"]`,
      )!;
      field.value = value;
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
  expect(container.querySelector('[name="authPath"]')).toBeNull();
  expect(container.textContent).not.toContain('Local Codex reuse requires');
  container.querySelector<HTMLInputElement>('[name="authEnv"]')!.value =
    'SYNTHETIC_DRAFT';
  await select('authKind', 'codex-local');
  expect(container.querySelector('[name="authEnv"]')).toBeNull();
  expect(container.textContent).toContain('Local Codex reuse requires');
  container.querySelector<HTMLInputElement>('[name="authPath"]')!.value =
    '/synthetic/draft/auth.json';
  await select('authKind', 'auth-json');
  expect(container.querySelector('[name="authPath"]')).toBeNull();
  expect(
    container.querySelector<HTMLInputElement>('[name="authEnv"]')?.value,
  ).toBe('SYNTHETIC_DRAFT');
  await select('authKind', 'codex-local');
  expect(
    container.querySelector<HTMLInputElement>('[name="authPath"]')?.value,
  ).toBe('/synthetic/draft/auth.json');
  await select('adapter', 'kilo');
  expect(
    container.querySelector<HTMLSelectElement>('[name="authKind"]')?.value,
  ).toBe('auth-json');
  expect(
    container.querySelector<HTMLInputElement>('[name="authEnv"]')?.value,
  ).toBe('');
  expect(container.querySelector('[name="authPath"]')).toBeNull();
  expect(container.textContent).not.toContain('Local Codex reuse requires');
});

it('reloads the selected credential field from changed configuration', async () => {
  await render(<FactoryCodingSetup />);
  await click('Configure coding');
  state = {
    ...state,
    configFingerprint: 'd'.repeat(64),
    config: {
      ...state.config,
      auth: { kind: 'codex-local', path: '/synthetic/reloaded/auth.json' },
    },
  };
  await act(async () => {
    client.setQueryData(['factory-coding-state'], state);
  });
  await flush();
  await click('Reload current coding settings');
  expect(
    container.querySelector<HTMLSelectElement>('[name="authKind"]')?.value,
  ).toBe('codex-local');
  expect(container.querySelector('[name="authEnv"]')).toBeNull();
  expect(
    container.querySelector<HTMLInputElement>('[name="authPath"]')?.value,
  ).toBe('/synthetic/reloaded/auth.json');
});
it('keeps coding labels and actions stable during delayed background refetch and blocks a missing next task', async () => {
  await render();
  const stop = button('Stop coding');
  const original = vi.mocked(fetch).getMockImplementation()!;
  let resolve!: (value: Response) => void;
  vi.mocked(fetch).mockImplementation((input, init) =>
    String(input).includes('/runs?')
      ? new Promise((yes) => {
          resolve = yes;
        })
      : original(input, init),
  );
  await act(async () => {
    void client.invalidateQueries({ queryKey: ['factory-coding-runs'] });
  });
  await flush();
  expect(button('Refresh coding').disabled).toBe(false);
  expect(stop.disabled).toBe(false);
  await act(async () =>
    resolve(
      response({ items: [{ sequence: 1, run: current }], nextCursor: null }),
    ),
  );
  await flush();
  expect(button('Stop coding')).toBe(stop);
  await act(async () => button('Refresh coding').click());
  expect(button('Refreshing coding…').disabled).toBe(true);
  await act(async () =>
    resolve(
      response({ items: [{ sequence: 1, run: current }], nextCursor: null }),
    ),
  );
  await flush();
  expect(button('Refresh coding').disabled).toBe(false);
  await render(<FactoryCoding key="other" workId="other" eligible />);
  expect(container.textContent).toContain('Loading coding attempts');
  expect(container.textContent).not.toContain('Stop coding');
  expect(button('Refresh coding').disabled).toBe(true);
});
it.each(['attempts', 'events'] as const)(
  'serializes manual refresh and loading more %s without cancelling pagination',
  async (kind) => {
    const events = kind === 'events';
    const matches = (url: string) =>
      url.includes(events ? '/events?' : '/runs?');
    const page = { items: [], nextCursor: 1 };
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) =>
      matches(String(input))
        ? Promise.resolve(response(page))
        : original(input, init),
    );
    await render(
      events ? (
        <FactoryCodingEvidence id="run-demo" />
      ) : (
        <FactoryCoding workId="work-demo" eligible />
      ),
    );
    if (events) {
      await act(async () => {
        const details = container.querySelector('details')!;
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
      });
      await flush();
      await flush();
    }
    let resolve!: (value: Response) => void;
    let signal: AbortSignal | null | undefined;
    let requests = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (!matches(String(input))) return original(input, init);
      requests++;
      signal = init?.signal;
      return new Promise((yes) => {
        resolve = yes;
      });
    });
    const refreshLabel = events ? 'Refresh events' : 'Refresh coding';
    const moreLabel = events ? 'Load more events' : 'Load more attempts';
    await click(moreLabel);
    expect(button(refreshLabel).disabled).toBe(true);
    await click(refreshLabel);
    expect(requests).toBe(1);
    expect(signal?.aborted).toBe(false);
    await act(async () => resolve(response({ items: [], nextCursor: 2 })));
    await flush();
    expect(button(refreshLabel).disabled).toBe(false);
    await click(refreshLabel);
    expect(button(moreLabel).disabled).toBe(true);
    const pending = requests;
    await click(moreLabel);
    expect(requests).toBe(pending);
    expect(signal?.aborted).toBe(false);
  },
);
it('shows fresh-release waiting state and explicit access to a single historical coding attempt', async () => {
  current = codingRun('candidate-awaiting-review');
  await render(
    <FactoryCoding
      workId="work-demo"
      eligible
      currentReleaseId="fresh-release"
    />,
  );
  expect(container.textContent).toContain('awaiting automatic dispatch');
  expect(container.querySelector('.factory-coding-run')).toBeNull();
  const picker = container.querySelector<HTMLSelectElement>(
    '.factory-coding-attempt-picker select',
  )!;
  expect(picker.value).toBe('');
  await act(async () => {
    picker.value = current!.record.runId;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
  await flush();
  expect(container.querySelector('.factory-coding-run')).not.toBeNull();
  await render(
    <FactoryCoding
      workId="work-demo"
      eligible
      currentReleaseId="fresh-release"
      currentNavigation={1}
    />,
  );
  expect(container.querySelector('.factory-coding-run')).toBeNull();
  expect(container.textContent).toContain('awaiting automatic dispatch');
});

it('shows persisted limit diagnostics and offers only a deliberate recheck after resolution', async () => {
  current = codingRun('candidate-awaiting-review');
  current.validationAdmission = {
    blocker: 'candidate-unavailable',
    reasonCode: 'file-too-large',
    message: 'A changed file exceeds the snapshot size limit.',
    recovery: 'Retrying the unchanged candidate will hit the same limit.',
    diagnosticReference: '12345678-1234-4234-8234-123456789012',
    observedAt: '2026-09-07T00:00:00.000Z',
    nextAction: 'inspect-diagnostics',
  };
  await render(
    <FactoryCoding
      workId="work-demo"
      eligible
      currentReleaseId="release-demo"
    />,
  );
  const attention = container.querySelector('#factory-validation-attention')!;
  expect(attention.textContent).toContain('file-too-large');
  expect(attention.textContent).toContain(
    '12345678-1234-4234-8234-123456789012',
  );
  expect(attention.textContent).toContain('unchanged candidate');
  expect(attention.textContent).toContain(
    'Resolve the issue above, then recheck validation',
  );
  expect(button('Recheck validation').disabled).toBe(false);
  expect(attention.querySelector('a')).toBeNull();
  expect(calls).toEqual([]);
});
it.each([true, false])(
  'only offers explicit validation retry for current release: %s',
  async (isCurrent) => {
    current = codingRun('candidate-awaiting-review');
    current.validationAdmission = {
      blocker: 'candidate-unavailable',
      reasonCode: 'capture-failed',
      message: 'Snapshot capture failed.',
      recovery: 'Retry after resolving the cause.',
      observedAt: '2026-09-07T00:00:00.000Z',
      nextAction: 'retry-validation',
    };
    await render(
      <FactoryCoding
        workId="work-demo"
        eligible
        currentReleaseId={isCurrent ? 'release-demo' : 'new-release'}
      />,
    );
    if (!isCurrent) {
      await act(async () => {
        const select = container.querySelector('select')!;
        select.value = 'run-demo';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flush();
    }
    expect(calls).toEqual([]);
    const retry = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'Retry validation admission',
    );
    expect(!!retry).toBe(isCurrent);
    if (isCurrent) {
      await click('Retry validation admission');
      expect(calls).toEqual([
        {
          url: '/api/factory-delivery/candidates/run-demo/validation/retry',
          body: {
            expectedVersion: 3,
            reason:
              'Human requested retry of the existing released validation policy',
          },
        },
      ]);
    }
  },
);
it('retries the current saved generic attention and renders the fresh specific blocker', async () => {
  current = codingRun('candidate-awaiting-review');
  current.validationAdmission = {
    blocker: 'candidate-unavailable',
    message: 'Reconcile its evidence and retry validation.',
    observedAt: '2026-09-01T00:00:00.000Z',
    nextAction: 'retry-validation',
  };
  const originalFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (
      init?.method === 'POST' &&
      String(input).endsWith('/validation/retry')
    ) {
      calls.push({ url: String(input), body: JSON.parse(String(init.body)) });
      current.validationAdmission = {
        blocker: 'candidate-unavailable',
        reasonCode: 'file-too-large',
        message:
          'Changed file assets/image.png is 4000000 bytes; limit 2097152 bytes.',
        recovery: 'Retrying the unchanged candidate cannot help.',
        observedAt: '2026-09-07T00:00:00.000Z',
        nextAction: 'inspect-diagnostics',
      };
      return response(current);
    }
    return originalFetch(input, init);
  });
  await render(
    <FactoryCoding
      workId="work-demo"
      eligible
      currentReleaseId="release-demo"
    />,
  );
  expect(container.textContent).toContain(
    'Earlier failure did not record a specific reason',
  );
  expect(calls).toEqual([]);
  await click('Retry validation admission');
  await flush();
  expect(calls[0]?.body).toMatchObject({ expectedVersion: 3 });
  expect(container.textContent).toContain('4000000 bytes; limit 2097152 bytes');
  expect(button('Recheck validation').disabled).toBe(false);
});
