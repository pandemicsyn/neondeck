import { validationPreview } from './FactoryDelivery.fixtures';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { FactoryReleaseCoding } from './FactoryReleaseCoding';
import { codingState } from './FactoryCoding.fixtures';
import { getFactoryCodingState } from '../../api/factory-coding';
vi.mock('../../api/factory-delivery', () => ({
  getFactoryValidationPolicy: vi.fn(
    async () => validationPreview().validationPolicy,
  ),
}));
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
  client.setQueryData(
    ['factory-validation-policy', 'demo'],
    validationPreview().validationPolicy,
  );
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
          repoId="demo"
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
  expect(release).toHaveBeenCalledExactlyOnceWith(
    state.configFingerprint,
    validationPreview().validationPolicy,
  );
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
  expect(release).toHaveBeenCalledExactlyOnceWith(
    next.configFingerprint,
    validationPreview().validationPolicy,
  );
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
    validationPreview().validationPolicy,
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
  expect(release).toHaveBeenCalledWith(
    state.configFingerprint,
    validationPreview().validationPolicy,
  );
});
it('keeps reviewed release controls stable through polling, but blocks changed settings and failed retries', async () => {
  vi.useFakeTimers();
  let resolve!: (value: ReturnType<typeof codingState>) => void;
  let reject!: (error: Error) => void;
  vi.mocked(getFactoryCodingState).mockImplementation(
    () =>
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  try {
    await render();
    const action = button('Release v2');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(getFactoryCodingState).toHaveBeenCalledTimes(1);
    expect(button('Refresh execution settings').disabled).toBe(false);
    expect(action.disabled).toBe(false);
    await act(async () => action.click());
    expect(release).toHaveBeenCalledWith(
      codingState().configFingerprint,
      validationPreview().validationPolicy,
    );
    await act(async () => {
      resolve(codingState());
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(button('Release v2')).toBe(action);
    expect(action.disabled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    const changed = codingState();
    changed.configFingerprint = 'e'.repeat(64);
    changed.config.model = 'changed-model';
    await act(async () => {
      resolve(changed);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(action.disabled).toBe(true);
    expect(fact('Model')).not.toBe('changed-model');
    await act(async () => button('Review updated execution settings').click());
    expect(fact('Model')).toBe('changed-model');
    expect(action.disabled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
      reject(new Error('offline'));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(action.disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(action.disabled).toBe(true);
    expect(container.textContent).toContain('Coding selection is unavailable');
    await act(async () => {
      resolve(changed);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(action.disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('binds new plan approval to the displayed validation policy and blocks changed policy', async () => {
  const policy = {
    version: 'local-validation-v1',
    configFingerprint: 'e'.repeat(64),
    checkCommands: ['npm test'],
    reviewerModel: 'synthetic-reviewer',
    reviewerThinkingLevel: null,
    maxRepairAttempts: 2,
    totalExecutionMs: 10800000,
  };
  client.setQueryData(['factory-validation-policy', 'demo'], policy);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FactoryReleaseCoding
          label="Approve plan and start"
          repoId="demo"
          disabled={false}
          onRelease={release}
        />
      </QueryClientProvider>,
    ),
  );
  expect(container.textContent).toContain(
    'automatic local checks and independent review',
  );
  await act(async () => button('Approve plan and start').click());
  expect(release).toHaveBeenLastCalledWith(
    codingState().configFingerprint,
    policy,
  );
  await act(async () =>
    client.setQueryData(['factory-validation-policy', 'demo'], {
      ...policy,
      reviewerModel: 'changed-reviewer',
    }),
  );
  await flush();
  expect(button('Approve plan and start').disabled).toBe(true);
  await act(async () => button('Review validation policy').click());
  expect(button('Approve plan and start').disabled).toBe(false);
});

it('retains the actionable validation failure beside approval through repeated no-data polls until recovery', async () => {
  vi.useFakeTimers();
  client.removeQueries({ queryKey: ['factory-validation-policy'] });
  const { getFactoryValidationPolicy } =
    await import('../../api/factory-delivery');
  const missing = 'Configure an independent reviewer model before release.';
  let resolve!: (
    value: ReturnType<typeof validationPreview>['validationPolicy'],
  ) => void;
  let reject!: (error: Error) => void;
  vi.mocked(getFactoryValidationPolicy).mockImplementation(
    () =>
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  try {
    await render();
    const action = button('Release v2');
    expect(action.disabled).toBe(true);
    await act(async () => {
      reject(new Error(missing));
      await vi.advanceTimersByTimeAsync(1);
    });
    const panel = container.querySelector('[role="alert"]');
    const reload = button('Reload validation policy');
    const refreshSettings = button('Refresh execution settings');
    const failedMarkup = container.innerHTML;
    expect(panel?.textContent).toContain(missing);
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
      });
      expect(
        client.getQueryState(['factory-validation-policy', 'demo'])?.status,
      ).toBe('pending');
      expect(container.querySelector('[role="alert"]')).toBe(panel);
      expect(panel?.isConnected).toBe(true);
      expect(reload.disabled).toBe(false);
      expect(refreshSettings.disabled).toBe(false);
      expect(container.innerHTML).toBe(failedMarkup);
      expect(action.disabled).toBe(true);
      await act(async () => action.click());
      expect(release).not.toHaveBeenCalled();
      await act(async () => {
        reject(new Error(missing));
        await vi.advanceTimersByTimeAsync(1);
      });
    }
    const notice = document.getElementById(
      action.getAttribute('aria-describedby')!,
    );
    expect(notice?.textContent).toContain(missing);
    expect(notice?.querySelector('a')?.textContent).toBe(
      'Configure PR review model',
    );
    expect(notice?.nextElementSibling).toBe(action);
    expect(notice?.textContent).toContain(
      'Dashboard → NEON → RUNTIME → CONFIG → MODELS → PR review',
    );
    await act(async () => button('Reload validation policy').click());
    expect(reload.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBe(panel);
    await act(async () => {
      resolve(validationPreview().validationPolicy);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(action.disabled).toBe(false);
    expect(container.textContent).toContain(
      validationPreview().validationPolicy.reviewerModel,
    );
    await act(async () => action.click());
    expect(release).toHaveBeenCalledExactlyOnceWith(
      codingState().configFingerprint,
      validationPreview().validationPolicy,
    );
  } finally {
    vi.useRealTimers();
    vi.mocked(getFactoryValidationPolicy).mockResolvedValue(
      validationPreview().validationPolicy,
    );
  }
});

it('retains a reviewed policy after failures and requires review of changed recovery data', async () => {
  const { getFactoryValidationPolicy } =
    await import('../../api/factory-delivery');
  const original = validationPreview().validationPolicy;
  const changed = {
    ...original,
    reviewerModel: 'replacement-reviewer',
    configFingerprint: 'f'.repeat(64),
  };
  await render();
  vi.mocked(getFactoryValidationPolicy).mockRejectedValue(
    new Error('Missing reviewer'),
  );
  await act(async () => {
    await client.refetchQueries({ queryKey: ['factory-validation-policy'] });
  });
  await flush();
  expect(button('Release v2').disabled).toBe(true);
  expect(container.textContent).toContain(original.reviewerModel);
  vi.mocked(getFactoryValidationPolicy).mockResolvedValue(changed);
  await act(async () => button('Reload validation policy').click());
  await flush();
  const action = button('Release v2');
  expect(action.disabled).toBe(true);
  expect(container.textContent).toContain(original.reviewerModel);
  expect(
    document.getElementById(action.getAttribute('aria-describedby')!)
      ?.textContent,
  ).toContain('Review the changed validation policy');
  await act(async () => action.click());
  expect(release).not.toHaveBeenCalled();
  await act(async () => button('Review validation policy').click());
  await act(async () => action.click());
  expect(release).toHaveBeenCalledExactlyOnceWith(
    codingState().configFingerprint,
    changed,
  );
  vi.mocked(getFactoryValidationPolicy).mockResolvedValue(original);
});

it('does not carry a missing-reviewer error or reviewed policy into another repository', async () => {
  const { getFactoryValidationPolicy } =
    await import('../../api/factory-delivery');
  client.removeQueries({ queryKey: ['factory-validation-policy'] });
  vi.mocked(getFactoryValidationPolicy).mockRejectedValue(
    new Error('Demo reviewer missing'),
  );
  await render();
  await flush();
  expect(container.textContent).toContain('Demo reviewer missing');
  vi.mocked(getFactoryValidationPolicy).mockImplementation(
    () => new Promise(() => {}),
  );
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FactoryReleaseCoding
          label="Release v2"
          repoId="another-repo"
          disabled={false}
          onRelease={release}
        />
      </QueryClientProvider>,
    ),
  );
  expect(container.textContent).not.toContain('Demo reviewer missing');
  const action = button('Release v2');
  expect(action.disabled).toBe(true);
  expect(
    document.getElementById(action.getAttribute('aria-describedby')!)
      ?.textContent,
  ).toContain('validation policy loads successfully');
  expect(release).not.toHaveBeenCalled();
  vi.mocked(getFactoryValidationPolicy).mockResolvedValue(
    validationPreview().validationPolicy,
  );
});

it('keeps the outer refresh label and enabled state stable during no-data coding retries', async () => {
  vi.useFakeTimers();
  client.removeQueries({ queryKey: key });
  let resolve!: (value: ReturnType<typeof codingState>) => void;
  let reject!: (error: Error) => void;
  vi.mocked(getFactoryCodingState).mockImplementation(
    () =>
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  try {
    await render();
    expect(button('Refreshing execution settings…').disabled).toBe(true);
    await act(async () => {
      reject(new Error('Coding unavailable'));
      await vi.advanceTimersByTimeAsync(1);
    });
    const refreshSettings = button('Refresh execution settings');
    const markup = container.innerHTML;
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
      });
      expect(button('Refresh execution settings')).toBe(refreshSettings);
      expect(refreshSettings.disabled).toBe(false);
      expect(container.innerHTML).toBe(markup);
      expect(release).not.toHaveBeenCalled();
      await act(async () => {
        reject(new Error('Coding unavailable'));
        await vi.advanceTimersByTimeAsync(1);
      });
    }
    await act(async () => refreshSettings.click());
    expect(button('Refreshing execution settings…').disabled).toBe(true);
    await act(async () => {
      resolve(codingState());
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(button('Release v2').disabled).toBe(false);
    expect(button('Refresh execution settings').disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
