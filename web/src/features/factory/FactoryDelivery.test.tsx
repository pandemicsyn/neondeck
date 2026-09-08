// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { FactoryDelivery } from './FactoryDelivery';
import { FactoryDeliveryDetail } from './FactoryDeliveryDetail';
import {
  publicationGrantInputSchema,
  validationGrantPreviewSchema,
} from '../../../../shared/factory-delivery-api';
import {
  deliveryDetail,
  deliveryPreview,
  deliveryEvidenceContent,
} from './FactoryDelivery.fixtures';
import {
  deliveryDetailSchema,
  getFactoryDelivery,
  getFactoryReviewedDiff,
  type DeliveryDetail,
} from '../../api/factory-delivery';
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let current: DeliveryDetail | undefined;
let postStatus: number;
let publicationBlocked: boolean;
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
  publicationBlocked = false;
  calls = [];
  sessionStorage.clear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      calls.push({ url, body: JSON.parse(String(init.body)) as unknown });
      if (postStatus !== 200)
        return response({ error: 'Synthetic conflict' }, postStatus);
      current = deliveryDetail();
      if (url.endsWith('/publication-grants')) {
        const body = v.parse(
          publicationGrantInputSchema,
          JSON.parse(String(init.body)),
        );
        current.pipeline.publication = {
          requestId: body.requestId,
          requestFingerprint: '1'.repeat(64),
          authorizedBy: 'operator',
          authorizedAt: '2026-09-07T12:00:00.000Z',
          revision: body.preview.revision,
          evidenceFingerprint: body.preview.evidenceFingerprint,
          configFingerprint: body.preview.configFingerprint,
          target: body.preview.target,
        };
      }
      return response(current);
    }
    if (url.endsWith('/reviewed-diff'))
      return response({
        pipelineId: 'delivery-demo',
        revision: current?.pipeline.revision ?? deliveryPreview().revision,
        evidenceFingerprint: 'a'.repeat(64),
        diff: '',
        unavailableReason: null,
      });
    if (url.endsWith('/publication'))
      return response(
        publicationBlocked
          ? {
              ready: false,
              blocker: 'publication-setup',
              message:
                'Choose the repository credential reference in publication setup.',
              preview: null,
            }
          : {
              ready: true,
              blocker: null,
              message: 'Ready',
              preview: publicationPreview(),
            },
      );
    if (url.includes('/evidence/')) {
      const evidence = deliveryEvidenceContent(url.split('/').at(-1));
      const selected = current?.pipeline.evidence.find(
        (item) => item.id === evidence.evidenceId,
      );
      if (selected)
        Object.assign(evidence, {
          result: selected.result,
          revision: selected.revision,
        });
      return response(evidence);
    }
    if (url.endsWith('/state'))
      return response({ deliveries: current ? [current] : [] });
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
  automaticValidation = false,
) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FactoryDelivery
          automaticValidation={automaticValidation}
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
  vi.mocked(fetch).mockResolvedValue(
    response({
      pipelineId: 'other',
      revision: deliveryPreview().revision,
      evidenceFingerprint: 'a'.repeat(64),
      diff: '',
      unavailableReason: null,
    }),
  );
  await expect(getFactoryReviewedDiff('foreign-run')).rejects.toThrow(
    'another delivery',
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
    v.parse(validationGrantPreviewSchema, {
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
    'Independent checks: Not started for this candidate',
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
    'Fresh read-only review: Not started for this candidate',
  );
});
it('keeps full revision provenance accessible in a closed native disclosure', async () => {
  current = deliveryDetail();
  await render();
  const revision = [...container.querySelectorAll('details')].find((item) =>
    item
      .querySelector('summary')
      ?.textContent?.trim()
      .startsWith('Candidate and revision details'),
  );
  expect(revision?.open).toBe(false);
  expect(revision?.textContent).toContain(deliveryPreview().revision.treeSha);
  expect(revision?.textContent).toContain(deliveryPreview().configFingerprint);
  expect(calls).toHaveLength(0);
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
    progressAssessmentId: null,
    progressInputDigest: null,
    progressEvidenceDigest: null,
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

it.each(['planned', 'uncertain'] as const)(
  'distinguishes a previously pushed commit from a newer %s repair push after PR closure',
  async (state) => {
    current = deliveryDetail();
    const prior = current.pipeline.revision;
    const repaired = {
      ...prior,
      runId: 'repair-new',
      candidateDigest: '9'.repeat(64),
      treeSha: '9'.repeat(40),
    };
    current.pipeline.revision = repaired;
    current.pipeline.commits.push({
      revision: repaired,
      publishedHeadSha: '6'.repeat(40),
      treeSha: repaired.treeSha,
      evidenceRef: 'unpublished-local.json',
    });
    current.pipeline.effects.push({
      id: 'repair-push',
      kind: 'push',
      revision: repaired,
      state,
      receiptRef: state === 'planned' ? 'not-attempted.json' : 'uncertain.json',
      executionMs: null,
      reservedExecutionMs: null,
    });
    current.pipeline.outcome = 'closed';
    current.nextAction = 'complete';
    await render();
    const receipt = Array.from(container.querySelectorAll('summary')).find(
      (item) => item.textContent === 'Commit receipts',
    )!;
    await act(async () => {
      receipt.click();
    });
    const rows = Array.from(receipt.parentElement!.querySelectorAll('p'));
    expect(
      rows.find((row) => row.textContent?.includes('8'.repeat(40)))
        ?.textContent,
    ).toContain('Confirmed pushed commit');
    expect(
      rows.find((row) => row.textContent?.includes('6'.repeat(40)))
        ?.textContent,
    ).toContain('Local commit · push not confirmed');
    expect(container.textContent).not.toContain('Published commit:');
  },
);

it('distinguishes recorded in-flight checks from waiting without a polling live region', async () => {
  current = deliveryDetail();
  current.pipeline.effects = [
    {
      id: 'active-check',
      kind: 'verification',
      revision: current.pipeline.revision,
      state: 'in-flight',
      receiptRef: null,
      reservedExecutionMs: 1000,
      executionMs: null,
    },
  ];
  await render();
  const activity = container.querySelector(
    '[aria-label="Recorded delivery activity"]',
  );
  expect(activity?.textContent).toContain(
    'Running independent checks · in progress',
  );
  expect(activity?.hasAttribute('aria-live')).toBe(false);
  expect(container.textContent).not.toContain(
    'No checks or review are confirmed running',
  );
});
it('does not request another validation grant for an automatically authorized candidate', async () => {
  await render(undefined, 'candidate-demo', true);
  expect(container.textContent).toContain(
    'Preparing checks and independent review',
  );
  expect(container.querySelector('input[type=checkbox]')).toBeNull();
  expect(container.textContent).not.toContain('Start checks and review');
  expect(calls).toHaveLength(0);
});
it('requires separate publication consent and posts the exact reviewed candidate', async () => {
  current = deliveryDetail();
  current.pipeline.pr = null;
  current.nextAction = 'awaiting-publication';
  await render();
  expect(button('Create draft PR').disabled).toBe(true);
  expect(container.textContent).toContain('does not reset');
  const expected = publicationPreview();
  await consent();
  await click('Create draft PR');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    url: '/api/factory-delivery/deliveries/delivery-demo/publication-grants',
    body: { requestId: expect.any(String), confirm: true, preview: expected },
  });
});
it('blocks publication when the current review has not started even if readiness says ready', async () => {
  current = deliveryDetail();
  current.pipeline.pr = null;
  current.nextAction = 'awaiting-publication';
  current.pipeline.evidence.pop();
  await render();
  expect(button('Create draft PR').disabled).toBe(true);
  expect(container.textContent).toContain(
    'must pass for the current candidate',
  );
  expect(calls).toHaveLength(0);
});
it('preserves a task return link for publication setup without mutating intake', async () => {
  current = deliveryDetail();
  current.pipeline.pr = null;
  current.nextAction = 'awaiting-publication';
  publicationBlocked = true;
  await render();
  expect(
    container.querySelector('a[href="/factory?task=work-demo"]'),
  ).not.toBeNull();
  expect(container.textContent).toContain(
    'Choose the repository credential reference',
  );
  expect(calls).toHaveLength(0);
});
it('requires fresh publication consent after a rejected exact candidate', async () => {
  current = deliveryDetail();
  current.pipeline.pr = null;
  current.nextAction = 'awaiting-publication';
  postStatus = 409;
  await render();
  await consent();
  await click('Create draft PR');
  expect(button('Retry original decision').disabled).toBe(true);
  await click('Review a fresh decision');
  expect(button('Create draft PR').disabled).toBe(true);
  expect(calls).toHaveLength(1);
});

it('keeps historical work readable but requires withdrawing and releasing the retained plan again', async () => {
  await render();
  expect(container.textContent).toContain(
    'Release this plan again to use the updated workflow',
  );
  expect(container.textContent).toContain('withdraw the historical release');
  expect(container.textContent).not.toContain('Start checks and review');
  expect(container.querySelector('input[type=checkbox]')).toBeNull();
  expect(calls).toHaveLength(0);
});

function publicationPreview() {
  return {
    pipelineId: 'delivery-demo',
    expectedVersion: current?.pipeline.version ?? 4,
    revision: current?.pipeline.revision ?? deliveryPreview().revision,
    evidenceFingerprint: 'a'.repeat(64),
    configFingerprint: 'f'.repeat(64),
    target: deliveryPreview().target,
    publish: 'draft-pr-only',
    feedbackRepairs: true,
    merge: false,
    deploy: false,
  };
}
it('blocks publication when immutable reviewed changes are unavailable or bound to another candidate', async () => {
  current = deliveryDetail();
  current.pipeline.pr = null;
  current.nextAction = 'awaiting-publication';
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) =>
    String(input).endsWith('/reviewed-diff')
      ? response({
          pipelineId: 'delivery-demo',
          revision: { ...current!.pipeline.revision, treeSha: '9'.repeat(40) },
          evidenceFingerprint: 'a'.repeat(64),
          diff: '',
          unavailableReason: null,
        })
      : original(input, init),
  );
  await render();
  expect(button('Create draft PR').disabled).toBe(true);
  expect(container.textContent).toContain('does not match this candidate');
  vi.mocked(fetch).mockImplementation(async (input, init) =>
    String(input).endsWith('/reviewed-diff')
      ? response({
          pipelineId: 'delivery-demo',
          revision: current!.pipeline.revision,
          evidenceFingerprint: 'a'.repeat(64),
          diff: null,
          unavailableReason: 'The retained diff exceeds the display limit.',
        })
      : original(input, init),
  );
  await click('Reload publication readiness');
  expect(button('Create draft PR').disabled).toBe(true);
  expect(container.textContent).toContain('exceeds the display limit');
  expect(calls).toHaveLength(0);
});
it('shows the immutable clean reviewed diff before GitHub publication setup exists', async () => {
  current = deliveryDetail();
  current.pipeline.pr = null;
  current.nextAction = 'awaiting-publication';
  publicationBlocked = true;
  await render();
  expect(
    container.querySelector('[aria-label="Immutable reviewed changes"]'),
  ).not.toBeNull();
  expect(container.textContent).not.toContain('does not match this candidate');
  expect(container.textContent).toContain('Independent checks: passed');
  expect(
    container.querySelector('[aria-label="Publication setup"]'),
  ).not.toBeNull();
  expect(
    [...container.querySelectorAll('button')].some(
      (button) => button.textContent === 'Create draft PR',
    ),
  ).toBe(false);
  expect(calls).toHaveLength(0);
});
it('shows current failed independent review beside its immutable candidate diff', async () => {
  current = deliveryDetail('intervention');
  current.pipeline.evidence[1].result = 'failed';
  await render();
  expect(container.textContent).toContain('Fresh read-only review: failed');
  expect(
    container.querySelectorAll('[aria-label="Immutable reviewed changes"]'),
  ).toHaveLength(1);
  expect(container.querySelector('[aria-label="Create draft PR"]')).toBeNull();
  expect(calls).toHaveLength(0);
});
it('keeps every quoted filename change inspectable through a lossless raw diff fallback', async () => {
  current = deliveryDetail();
  current.pipeline.pr = null;
  current.nextAction = 'awaiting-publication';
  const patch =
    'diff --git "a/café.txt" "b/café.txt"\n--- "a/café.txt"\n+++ "b/café.txt"\n@@ -1 +1 @@\n-before\n+after\n\ndiff --git a/plain.txt b/plain.txt\n--- a/plain.txt\n+++ b/plain.txt\n@@ -1 +1 @@\n-old\n+new\n';
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) =>
    String(input).endsWith('/reviewed-diff')
      ? response({
          pipelineId: 'delivery-demo',
          revision: current!.pipeline.revision,
          evidenceFingerprint: 'a'.repeat(64),
          diff: patch,
          unavailableReason: null,
        })
      : original(input, init),
  );
  await render();
  expect(
    container.querySelector('[aria-label="Complete reviewed diff"]')
      ?.textContent,
  ).toBe(patch);
  expect(container.textContent).not.toContain(
    'No changes in the retained reviewed diff',
  );
  await consent();
  expect(button('Create draft PR').disabled).toBe(false);
});

it('explains environment failure and retries only after an explicit operator click', async () => {
  current = deliveryDetail();
  current.pipeline.pr = null;
  current.nextAction = 'human-environment';
  await render();
  expect(container.textContent).toContain('Environment setup failed');
  expect(container.textContent).toContain(
    'Setup stopped before validation and independent review',
  );
  expect(calls).toEqual([]);
  await click('Retry environment setup');
  expect(calls).toEqual([
    {
      url: '/api/factory-delivery/deliveries/delivery-demo/environment/retry',
      body: {
        expectedVersion: deliveryDetail().pipeline.version,
        reason:
          'Operator corrected the environment and requested retry of the approved workflow',
      },
    },
  ]);
});
it('retains a confirmed environment retry receipt when the next GET fails and an older GET completes late', async () => {
  current = deliveryDetail();
  current.pipeline.pr = null;
  current.nextAction = 'human-environment';
  await render();
  const old = structuredClone(current);
  const receipt = deliveryDetail();
  receipt.pipeline.pr = null;
  receipt.pipeline.version = old.pipeline.version + 1;
  const url = '/api/factory-delivery/deliveries/delivery-demo';
  const original = vi.mocked(fetch).getMockImplementation()!;
  let resolveOld!: (value: Response) => void;
  let retried = false;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input) === `${url}/environment/retry`) {
      retried = true;
      return response(receipt);
    }
    if (String(input) === url)
      return retried
        ? response({ error: 'Read unavailable' }, 503)
        : new Promise((resolve) => {
            resolveOld = resolve;
          });
    return original(input, init);
  });
  await act(async () => {
    void client.refetchQueries({
      queryKey: ['factory-delivery', 'delivery-demo'],
      exact: true,
    });
  });
  await click('Retry environment setup');
  expect(client.getQueryData(['factory-delivery', 'delivery-demo'])).toEqual(
    receipt,
  );
  expect(container.textContent).toContain('Validation and delivery activity');
  expect(container.textContent).toContain(
    'Refresh failed. Evidence may be stale',
  );
  expect(container.textContent).not.toContain('Control receipt is unconfirmed');
  expect(container.textContent).not.toContain('Environment setup failed');
  await act(async () => resolveOld(response(old)));
  await flush();
  expect(client.getQueryData(['factory-delivery', 'delivery-demo'])).toEqual(
    receipt,
  );
});
it('ignores an environment retry receipt after another delivery replaces the selected instance', async () => {
  const old = deliveryDetail();
  old.pipeline.pr = null;
  old.nextAction = 'human-environment';
  const other = structuredClone(old);
  other.pipeline.pipelineId = 'delivery-other';
  const receipt = structuredClone(old);
  receipt.pipeline.version++;
  receipt.nextAction = 'running';
  let resolvePost!: (value: Response) => void;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (init?.method === 'POST')
      return new Promise((resolve) => {
        resolvePost = resolve;
      });
    return response(String(input).endsWith('/delivery-other') ? other : old);
  });
  const select = async (id: string) => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <FactoryDeliveryDetail key={id} id={id} workId="work-demo" />
        </QueryClientProvider>,
      ),
    );
    await flush();
  };
  await select('delivery-demo');
  await click('Retry environment setup');
  await select('delivery-other');
  const requests = vi.mocked(fetch).mock.calls.length;
  await act(async () => resolvePost(response(receipt)));
  await flush();
  expect(fetch).toHaveBeenCalledTimes(requests);
  expect(client.getQueryData(['factory-delivery', 'delivery-demo'])).toEqual(
    old,
  );
  expect(client.getQueryData(['factory-delivery', 'delivery-other'])).toEqual(
    other,
  );
  expect(
    container.querySelector('#factory-delivery-delivery-other'),
  ).toBeTruthy();
  expect(button('Retry environment setup').disabled).toBe(false);
});
