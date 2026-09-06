// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryDeliveryProgress } from './FactoryDeliveryProgress';
import { FactoryDeliveryDetail } from './FactoryDeliveryDetail';
import {
  progressContent,
  progressDetail,
} from './FactoryDeliveryProgress.fixtures';
import { deliveryEvidenceContent } from './FactoryDelivery.fixtures';
import { getFactoryDeliveryProgressEvidence } from '../../api/factory-progress';
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let detail: ReturnType<typeof progressDetail>;
let content: ReturnType<typeof progressContent>;
const discuss = vi.fn();
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
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
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  detail = progressDetail();
  content = progressContent();
  discuss.mockReset();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/evidence/progress-demo')) return response(content);
    if (url.includes('/evidence/'))
      return response(deliveryEvidenceContent(url.split('/').at(-1)));
    return response(detail);
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.restoreAllMocks();
});
async function render(full = false, disabled = false) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        {full ? (
          <FactoryDeliveryDetail
            id="delivery-demo"
            workId="work-demo"
            onDiscuss={discuss}
          />
        ) : (
          <FactoryDeliveryProgress
            detail={detail}
            disabled={disabled}
            onDiscuss={discuss}
          />
        )}
      </QueryClientProvider>,
    ),
  );
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
}
it.each([
  'continue',
  'change-approach',
  'escalate',
  'pending',
  'uncertain',
  'error',
] as const)(
  'shows truthful %s state with assessed cycle and retained evidence',
  async (mode) => {
    detail = progressDetail(mode);
    content = progressContent(mode);
    await render();
    const expected = {
      continue: 'Continue',
      'change-approach': 'Change approach',
      escalate: 'Escalate to human planning',
      pending: 'Decision pending',
      uncertain: 'Decision uncertain',
      error: 'Assessment unavailable',
    }[mode];
    expect(container.textContent).toContain(expected);
    expect(container.textContent).toContain('Assessed repair 1 of 2');
    expect(container.textContent).toContain('action row measured 428px');
    expect(container.textContent).toContain(
      'No prior repair history was supplied',
    );
    expect(discuss).not.toHaveBeenCalled();
  },
);
it('shows a revised approach without a control that admits another repair', async () => {
  detail = progressDetail('change-approach');
  content = progressContent('change-approach');
  await render();
  expect(container.textContent).toContain('Keep the corrected header sizing');
  expect(container.textContent).toContain('same repair allowance');
  expect(container.querySelectorAll('button')).toHaveLength(0);
});
it('renders untrusted prose as text and preserves missing and shortened evidence cues', async () => {
  content.assessment.result!.rationale =
    '<img src=x onerror=alert(1)> Review the actual failure.';
  content.missingEvidence = ['Earlier check output unavailable'];
  content.omittedEvidence = ['Diff exceeds retained bound'];
  content.truncated = true;
  await render();
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('<img');
  expect(container.textContent).toContain('Missing evidence');
  expect(container.textContent).toContain('Omitted from assessment');
  expect(container.textContent).toContain('Presentation is shortened');
});
it('keeps history visible without offering stale or revoked assessment actions', async () => {
  content.isCurrent = false;
  await render();
  expect(container.textContent).toContain('Historical assessment');
  expect(container.textContent).not.toContain(
    'Discuss progress evidence with Neon',
  );
});
it('disables explicit planning transfer when delivery refresh is stale', async () => {
  await render(false, true);
  expect(container.querySelector('button')?.disabled).toBe(true);
  expect(discuss).not.toHaveBeenCalled();
});
it('fails closed when retained evidence cannot be validated', async () => {
  vi.mocked(fetch).mockResolvedValue(
    response({ error: 'Invalid evidence' }, 409),
  );
  await render();
  expect(container.textContent).toContain('Progress evidence unavailable');
  expect(
    Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Discuss progress evidence with Neon',
    )?.disabled,
  ).toBe(true);
  expect(container.textContent).not.toContain('Why this decision');
});
it('rejects mismatched response identities and malformed assessment states', async () => {
  content.evidenceId = 'foreign';
  await expect(
    getFactoryDeliveryProgressEvidence('delivery-demo', 'progress-demo'),
  ).rejects.toThrow('identity');
  vi.mocked(fetch).mockResolvedValue(
    response({
      ...content,
      assessment: { ...content.assessment, state: 'approved' },
    }),
  );
  await expect(
    getFactoryDeliveryProgressEvidence('delivery-demo', 'progress-demo'),
  ).rejects.toThrow();
});
it('transfers real progress findings only on explicit click, keeps revoke available and never posts chat', async () => {
  await render(true);
  expect(container.textContent).toContain('Revoke delivery authority');
  expect(discuss).not.toHaveBeenCalled();
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === 'Discuss progress evidence with Neon',
  )!;
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(discuss).toHaveBeenCalledOnce();
  expect(discuss.mock.calls[0][0]).toContain('action row measured 428px');
  expect(discuss.mock.calls[0][0]).toContain(
    'removes the narrow-screen assertion',
  );
  expect(
    vi
      .mocked(fetch)
      .mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
  ).toBe(true);
});
