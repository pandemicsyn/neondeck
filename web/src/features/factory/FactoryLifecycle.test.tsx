import { codingRun } from './FactoryCoding.fixtures';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  currentFactoryRun,
  factoryInboxPhase,
  FactoryLifecycle,
  FactoryStageSection,
  currentValidation,
  deliveryLifecycle,
} from './FactoryLifecycle';
import { deliveryDetail } from './FactoryDelivery.fixtures';
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it('does not treat absent review or stale check bundles as passing', () => {
  const detail = deliveryDetail();
  expect(currentValidation(detail).passed).toBe(true);
  detail.pipeline.evidence.pop();
  expect(currentValidation(detail).passed).toBe(false);
  const stale = deliveryDetail();
  stale.pipeline.evidence[1].verificationBundleDigest = '9'.repeat(64);
  expect(currentValidation(stale).review).toBeUndefined();
  stale.pipeline.revision = {
    ...stale.pipeline.revision,
    treeSha: '0'.repeat(40),
  };
  expect(currentValidation(stale).checks).toBeUndefined();
});
it('requires real passed checks and review and exposes failures', () => {
  const detail = deliveryDetail();
  detail.pipeline.pr = null;
  detail.pipeline.evidence[1].result = 'failed';
  expect(currentValidation(detail).passed).toBe(false);
  expect(deliveryLifecycle(detail).title).toBe('Validation found issues');
});
it('uses awaiting-publication for Approve PR and retains human intervention during PR watching', () => {
  const detail = deliveryDetail();
  detail.pipeline.pr = null;
  detail.nextAction = 'awaiting-publication';
  expect(deliveryLifecycle(detail).stage).toBe('Approve PR');
  detail.pipeline.evidence = [];
  expect(deliveryLifecycle(detail).title).toBe(
    'Current validation evidence needs attention',
  );
  const watched = deliveryDetail();
  watched.nextAction = 'human-budget';
  expect(deliveryLifecycle(watched)).toMatchObject({
    stage: 'Watch PR',
    title: 'Execution budget exhausted',
  });
  watched.pipeline.outcome = 'failed';
  watched.nextAction = 'complete';
  expect(deliveryLifecycle(watched).stage).not.toBe('Done');
  watched.pipeline.outcome = 'merged';
  expect(deliveryLifecycle(watched).stage).toBe('Done');
});
it('has exactly one accessible current stage and a working primary navigation action', () => {
  const navigate = vi.fn();
  act(() =>
    root.render(
      <FactoryLifecycle
        state={{
          stage: 'Validate',
          title: 'Checks in progress',
          nextAction: 'Inspect current evidence.',
        }}
        onNavigate={navigate}
      />,
    ),
  );
  expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
  expect(
    container.querySelector('[aria-current="step"]')?.textContent,
  ).toContain('Validate');
  act(() => container.querySelector('button')!.click());
  expect(navigate).toHaveBeenCalledOnce();
  act(() =>
    root.render(
      <FactoryLifecycle
        state={{
          stage: null,
          title: 'Status unavailable',
          nextAction: 'Reload evidence.',
        }}
      />,
    ),
  );
  expect(container.querySelector('[aria-current]')).toBeNull();
});
it('preserves mounted draft, selection and scroll when collapsed, and never automatically hides focus', () => {
  const render = (current: boolean, reveal = 0) =>
    act(() =>
      root.render(
        <FactoryStageSection title="Plan" current={current} reveal={reveal}>
          <textarea defaultValue={'First line\nSecond line'} />
          <div data-scroll style={{ overflow: 'auto', height: 10 }}>
            Retained transcript
          </div>
        </FactoryStageSection>,
      ),
    );
  render(true);
  const textarea = container.querySelector('textarea')!;
  textarea.focus();
  textarea.setSelectionRange(2, 7);
  const scroll = container.querySelector<HTMLElement>('[data-scroll]')!;
  scroll.scrollTop = 40;
  render(false);
  expect(container.querySelector('[hidden]')).toBeNull();
  expect(document.activeElement).toBe(textarea);
  act(() => container.querySelector('button')!.click());
  expect(container.querySelector('textarea')).toBe(textarea);
  expect(textarea.value).toBe('First line\nSecond line');
  expect(textarea.selectionStart).toBe(2);
  expect(scroll.scrollTop).toBe(40);
  render(false, 1);
  expect(container.querySelector('[hidden]')).toBeNull();
});

it('never uses a historical release to label the current task in the inbox', () => {
  const item = {
    id: 'work-demo',
    specVersion: 4,
    lifecycle: 'queued' as const,
  };
  const context = {
    work: item,
    eligible: true,
    releases: [{ id: 'current-release', specVersion: 4, withdrawnAt: null }],
  };
  const old = deliveryDetail();
  old.pipeline.outcome = 'merged';
  expect(factoryInboxPhase(item, context, [old], false)).toBe('Plan approved');
  const current = deliveryDetail();
  current.pipeline.initialRevision.releaseId = 'current-release';
  expect(factoryInboxPhase(item, context, [old, current], false)).toBe(
    'Watch PR',
  );
  expect(factoryInboxPhase(item, undefined, [old, current], false)).toBe(
    'Plan approved',
  );
});

it('does not select a historical run after releasing the same spec again before new coding starts', () => {
  const old = codingRun('candidate-awaiting-review');
  const { workItemId, specVersion, releaseId } = old.record.snapshot;
  expect(
    currentFactoryRun(workItemId, 'fresh-release', specVersion, [old]),
  ).toBeUndefined();
  expect(currentFactoryRun(workItemId, releaseId, specVersion, [old])).toBe(
    old,
  );
});
