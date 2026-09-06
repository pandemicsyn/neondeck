// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { FactoryDelivery } from './FactoryDelivery';
import { deliveryGrantPreviewSchema } from '../../../../shared/factory-delivery-api';
import {
  deliveryDetail,
  deliveryPreview,
  deliveryEvidenceContent,
} from './FactoryDelivery.fixtures';
import {
  deliveryDetailSchema,
  getFactoryDelivery,
  getFactoryDeliveryPreview,
  type DeliveryDetail,
} from '../../api/factory-delivery';
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let current: DeliveryDetail | undefined;
let postStatus: number;
let calls: { url: string; body: unknown }[];
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
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  current = undefined;
  postStatus = 200;
  calls = [];
  sessionStorage.clear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      calls.push({ url, body: JSON.parse(String(init.body)) as unknown });
      if (postStatus !== 200)
        return response({ error: 'Synthetic conflict' }, postStatus);
      current = deliveryDetail();
      return response(current);
    }
    if (url.includes('/evidence/'))
      return response(deliveryEvidenceContent(url.split('/').at(-1)));
    if (url.endsWith('/state'))
      return response({ deliveries: current ? [current] : [] });
    if (url.includes('/candidates/')) return response(deliveryPreview());
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
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
async function render(
  onDiscuss?: (evidence: string) => void,
  runId = 'candidate-demo',
) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FactoryDelivery
          runId={runId}
          releaseId="release-03"
          workId="work-demo"
          onDiscuss={onDiscuss}
        />
      </QueryClientProvider>,
    ),
  );
  await flush();
  await flush();
}
function button(label: string) {
  const value = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === label,
  );
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}
async function click(label: string) {
  await act(async () => button(label).click());
  await flush();
}
async function consent() {
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
  );
}
it('requires exact human consent and posts the visible immutable preview', async () => {
  await render();
  expect(calls).toHaveLength(0);
  expect(button('Grant bounded draft delivery').disabled).toBe(true);
  expect(container.textContent).toContain('release-03');
  expect(container.textContent).toContain('45 minutes per attempt');
  expect(container.textContent).toContain(
    'Merge and deployment are never authorized',
  );
  await consent();
  await click('Grant bounded draft delivery');
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toEqual({
    requestId: expect.any(String),
    confirm: true,
    preview: deliveryPreview(),
  });
});
it('replays an uncertain grant with identical id and preview', async () => {
  postStatus = 503;
  await render();
  await consent();
  await click('Grant bounded draft delivery');
  await click('Retry original delivery grant');
  expect(calls).toHaveLength(2);
  expect(calls[1].body).toEqual(calls[0].body);
});
it('requires a fresh review and new consent after version conflict', async () => {
  postStatus = 409;
  await render();
  await consent();
  await click('Grant bounded draft delivery');
  expect(container.textContent).toContain('Version conflict');
  expect(button('Retry original delivery grant').disabled).toBe(true);
  await click('Review a fresh grant');
  expect(button('Grant bounded draft delivery').disabled).toBe(true);
});
it('renders loading and unsupported state without granting', async () => {
  vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}));
  await render();
  expect(container.textContent).toContain('Loading delivery authority');
  expect(container.querySelector('input')).toBeNull();
});
it('fails closed on malformed state', async () => {
  vi.mocked(fetch).mockResolvedValue(
    response({ deliveries: [{ nextAction: 'unknown' }] }),
  );
  await render();
  expect(container.textContent).toContain('Delivery state unavailable');
  expect(container.querySelector('input')).toBeNull();
});
it('shows independent evidence, PR review link and no merge control', async () => {
  current = deliveryDetail();
  await render();
  expect(container.textContent).toContain('Independent checks: passed');
  expect(container.textContent).toContain('Fresh read-only review: passed');
  expect(container.querySelector('a[href^="/review?"]')).not.toBeNull();
  expect(
    [...container.querySelectorAll('button')].some((b) =>
      /merge/i.test(b.textContent ?? ''),
    ),
  ).toBe(false);
});
it('routes scope intervention to existing planning with candidate evidence', async () => {
  current = deliveryDetail('intervention');
  await render();
  expect(container.textContent).toContain('outside the released scope');
  expect(
    container.querySelector('a[href="/factory?task=work-demo"]'),
  ).not.toBeNull();
  expect(container.textContent).toContain('intervention-demo');
});
it('reconciles uncertain effects using the viewed version', async () => {
  current = deliveryDetail('uncertain');
  await render();
  await click('Reconcile delivery receipts');
  expect(calls[0]).toEqual({
    url: '/api/factory-delivery/deliveries/delivery-demo/reconcile',
    body: {
      expectedVersion: 4,
      reason: 'Human requested observation of uncertain delivery effects',
    },
  });
});
it('requires a reason before revocation', async () => {
  current = deliveryDetail();
  await render();
  await click('Revoke delivery authority');
  expect(button('Confirm revocation').disabled).toBe(true);
  expect(calls).toHaveLength(0);
});
it('disables controls when refreshed detail fails', async () => {
  current = deliveryDetail('uncertain');
  await render();
  vi.mocked(fetch).mockResolvedValue(response({ error: 'offline' }, 503));
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ['factory-delivery', 'delivery-demo'],
    });
  });
  await flush();
  expect(button('Reconcile delivery receipts').disabled).toBe(true);
  expect(button('Revoke delivery authority').disabled).toBe(true);
});
it('rejects mismatched requested identities independently', async () => {
  vi.mocked(fetch).mockResolvedValue(response(deliveryPreview()));
  await expect(getFactoryDeliveryPreview('foreign-run')).rejects.toThrow(
    'identity',
  );
  vi.mocked(fetch).mockResolvedValue(response(deliveryDetail()));
  await expect(getFactoryDelivery('foreign-delivery')).rejects.toThrow(
    'identity',
  );
});
it('rejects unknown actions and malformed authority on the dashboard boundary', () => {
  expect(() =>
    v.parse(deliveryDetailSchema, { ...deliveryDetail(), nextAction: 'merge' }),
  ).toThrow();
  for (const field of [
    'consumedExecutionMs',
    'reservedExecutionMs',
    'remainingExecutionMs',
    'repairsUsed',
    'repairsRemaining',
  ] as const) {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const malformed = deliveryDetail();
      malformed.budget[field] = value;
      expect(() => v.parse(deliveryDetailSchema, malformed)).toThrow();
    }
  }
  expect(() =>
    v.parse(deliveryGrantPreviewSchema, {
      ...deliveryPreview(),
      initialExecutionMs: 10800001,
    }),
  ).toThrow();
  const detail = deliveryDetail();
  detail.pipeline.authorization.totalExecutionMs = 10800001;
  expect(() => v.parse(deliveryDetailSchema, detail)).toThrow();
});

it('attaches exact intervention evidence only on human discussion action', async () => {
  current = deliveryDetail('intervention');
  const discuss = vi.fn();
  await render(discuss);
  expect(discuss).not.toHaveBeenCalled();
  await click('Discuss delivery evidence with Neon');
  expect(discuss).toHaveBeenCalledWith(
    expect.stringContaining('intervention-demo'),
  );
  expect(discuss).toHaveBeenCalledWith(
    expect.stringContaining('remainingExecutionMs'),
  );
  expect(calls).toHaveLength(0);
});
it('renders authoritative consumed, reserved and remaining execution', async () => {
  current = deliveryDetail();
  await render();
  const budget = container.querySelector('[aria-label="Delivery budget"]');
  expect(budget?.textContent).toContain('30 min');
  expect(budget?.textContent).toContain('10 min');
  expect(budget?.textContent).toContain('140 min');
});
it('does not reuse passed evidence from an older tree', async () => {
  current = deliveryDetail();
  current.pipeline.revision = {
    ...current.pipeline.revision,
    treeSha: '9'.repeat(40),
  };
  await render();
  expect(container.textContent).toContain(
    'Independent checks: Pending, no current evidence',
  );
  expect(container.textContent).toContain(
    'Prior or unmatched evidence, not current certification',
  );
});

it('keeps a repair child on the existing release delivery without offering another grant', async () => {
  current = deliveryDetail();
  await render(undefined, 'repair-child-demo');
  expect(container.textContent).toContain(
    'This release already has a delivery',
  );
  expect(container.textContent).toContain('Inspect existing delivery');
  expect(container.querySelector('input[type=checkbox]')).toBeNull();
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([url]) => String(url).includes('/candidates/')),
  ).toBe(false);
});
it('does not present an unmatched review bundle as a current passing review', async () => {
  current = deliveryDetail();
  current.pipeline.evidence[1].verificationBundleDigest = '7'.repeat(64);
  await render();
  expect(container.textContent).toContain(
    'Fresh read-only review: Pending, no current evidence',
  );
});
it('keeps full revision provenance accessible in a closed native disclosure', async () => {
  await render();
  const revision = [...container.querySelectorAll('details')].find(
    (item) => item.querySelector('summary')?.textContent === 'Revision details',
  );
  expect(revision?.open).toBe(false);
  expect(revision?.textContent).toContain(deliveryPreview().revision.treeSha);
  expect(revision?.textContent).toContain(deliveryPreview().configFingerprint);
  expect(button('Grant bounded draft delivery').disabled).toBe(true);
});
it('places the human intervention before technical provenance and evidence history', async () => {
  current = deliveryDetail('intervention');
  await render(vi.fn());
  const intervention = container.querySelector(
    '[aria-label="Delivery intervention"]',
  )!;
  const evidence = container.querySelector(
    '[aria-label="Independent validation"]',
  )!;
  expect(
    intervention.compareDocumentPosition(evidence) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  expect(intervention.textContent).toContain(
    'Discuss delivery evidence with Neon',
  );
});

it('renders bounded check output, findings and receipt eligibility on expansion', async () => {
  current = deliveryDetail('intervention');
  await render();
  const summary = Array.from(container.querySelectorAll('summary')).find(
    (item) => item.textContent === 'blocked · Current tree',
  )!;
  await act(async () => {
    summary.click();
  });
  await flush();
  expect(container.textContent).toContain('12 tests passed');
  expect(container.textContent).toContain('Changing navigation destinations');
  expect(container.textContent).toContain('Usage accounted');
  expect(container.textContent).toContain('Not eligible for publication');
});

it('sends actual findings and bounded check output in explicit planning context', async () => {
  current = deliveryDetail('intervention');
  const discuss = vi.fn();
  await render(discuss);
  await click('Discuss delivery evidence with Neon');
  expect(discuss).toHaveBeenCalledWith(
    expect.stringContaining('Changing navigation destinations'),
  );
  expect(discuss).toHaveBeenCalledWith(
    expect.stringContaining('12 tests passed'),
  );
  expect(discuss).not.toHaveBeenCalledWith(
    expect.stringContaining('review-demo.json'),
  );
});

it('does not send an incomplete briefing when an evidence read fails', async () => {
  current = deliveryDetail('intervention');
  const discuss = vi.fn();
  await render(discuss);
  vi.mocked(fetch).mockResolvedValue(
    response({ error: 'Receipt unavailable' }, 409),
  );
  await click('Discuss delivery evidence with Neon');
  expect(discuss).not.toHaveBeenCalled();
  expect(container.textContent).toContain('no incomplete briefing was sent');
});

it('uses the canonical backend contract for feedback, watch timestamps and long repair reasons', async () => {
  current = deliveryDetail();
  current.pipeline.coordinator.watchObservedAt = '2026-09-06T12:30:00.000Z';
  current.pipeline.feedback.push({
    id: 'feedback-1',
    fingerprint: '4'.repeat(64),
    revision: current.pipeline.revision,
    publishedHeadSha: '5'.repeat(40),
    ciFailed: true,
    hasReviewFeedback: false,
    evidenceRef: 'synthetic-ci.json',
    classification: null,
    repairRequestId: null,
  });
  current.pipeline.effects.push({
    id: 'feedback-review-1',
    kind: 'feedback-review',
    revision: current.pipeline.revision,
    state: 'planned',
    receiptRef: null,
    reservedExecutionMs: 1000,
    executionMs: null,
  });
  current.pipeline.repairs.push({
    runId: 'repair-1',
    attemptId: 'attempt-2',
    requestId: 'repair-request',
    reservedExecutionMs: 1000,
    executionMs: null,
    fromRevision: current.pipeline.revision,
    status: 'reserved',
    revision: null,
    reason: 'Scoped repair evidence. '.repeat(500),
  });
  expect(await getFactoryDelivery('delivery-demo')).toEqual(current);
});

it('shows the triggering external scope classification and sends its actual findings before check history', async () => {
  current = deliveryDetail('intervention');
  const discuss = vi.fn();
  await render(discuss);
  expect(container.textContent).toContain(
    'External review requests a new navigation destination',
  );
  expect(container.textContent).toContain(
    'The external request adds an account settings destination',
  );
  expect(container.textContent).toContain('Bound to this observation');
  expect(container.textContent).toContain('not publication certification');
  expect(discuss).not.toHaveBeenCalled();
  await click('Discuss delivery evidence with Neon');
  const context: string = discuss.mock.calls[0][0];
  expect(context).toContain(
    'The external request adds an account settings destination',
  );
  expect(context).toContain('Please add account settings');
  expect(context.indexOf('feedback-demo')).toBeLessThan(
    context.indexOf('review-demo'),
  );
  expect(context).not.toContain('classification.json');
});

it('keeps prior external feedback available as history without labelling it the current trigger', async () => {
  current = deliveryDetail('intervention');
  current.pipeline.feedback[0].revision = {
    ...current.pipeline.revision,
    treeSha: '9'.repeat(40),
  };
  await render();
  expect(container.textContent).not.toContain(
    'Triggering external scope feedback',
  );
  expect(container.textContent).toContain('External feedback · scope change');
  vi.mocked(fetch).mockResolvedValue(
    response({
      ...deliveryEvidenceContent('feedback-demo'),
      revision: current.pipeline.feedback[0].revision,
      isCurrent: false,
    }),
  );
  const history = Array.from(container.querySelectorAll('summary')).find(
    (item) => item.textContent === 'External feedback · scope change',
  )!;
  await act(async () => {
    history.click();
  });
  await flush();
  expect(container.textContent).toContain('Prior revision');
});
