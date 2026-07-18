// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import {
  PrReviewNeonFindingAnnotation,
  PrReviewNeonFindingsPanel,
} from './PrReviewNeonFinding';
import { neonFindingAnnotationId } from './review-findings';

describe('Neon finding review components', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders title, explanation, severity, confidence, action, provenance, and local dismissal accessibly', async () => {
    const onDismiss = vi.fn<(finding: NeonReviewFinding) => void>();
    const active = finding('active');
    await act(async () => {
      root.render(
        <PrReviewNeonFindingAnnotation
          compact={false}
          finding={active}
          isDismissing={false}
          onDismiss={onDismiss}
          selected
        />,
      );
    });

    const annotation = container.querySelector('article');
    expect(annotation?.getAttribute('aria-label')).toBe(
      'Neon major finding, active, high confidence',
    );
    expect(container.textContent).toContain('Avoid a null crash');
    expect(container.textContent).toContain('Guard the optional value');
    expect(container.textContent).toContain('Suggested action: Add a guard.');
    expect(container.textContent).toContain(
      'Neon · role display-assistant · model openai/gpt-5 · run run-42',
    );
    expect(container.querySelector('time')?.getAttribute('dateTime')).toBe(
      '2026-07-18T12:00:00.000Z',
    );

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onDismiss).toHaveBeenCalledWith(active);
  });

  it('keeps every lifecycle and report-only anchor state visible in the inspector', async () => {
    const findings = (
      ['active', 'stale', 'resolved', 'dismissed', 'promoted'] as const
    ).map((state) => finding(state));
    await act(async () => {
      root.render(
        <PrReviewNeonFindingsPanel
          activePath="src/a.ts"
          findings={findings}
          isDismissing={() => false}
          onDismiss={vi.fn<(finding: NeonReviewFinding) => void>()}
          onSelect={vi.fn<(finding: NeonReviewFinding) => void>()}
          resolutionFor={(item) =>
            item.lifecycle.state === 'active'
              ? {
                  state: 'unavailable',
                  reason: 'The declared hunk does not exist in this patch.',
                }
              : {
                  state: 'stale',
                  reason: 'This finding belongs to an old revision.',
                }
          }
          selectedAnnotationId={neonFindingAnnotationId('active')}
        />,
      );
    });

    for (const state of [
      'active',
      'stale',
      'resolved',
      'dismissed',
      'promoted',
    ]) {
      expect(container.textContent).toContain(`${state}, high confidence`);
    }
    expect(container.textContent).toContain(
      'Report only: The declared hunk does not exist in this patch.',
    );
    expect(
      container.querySelector('[aria-current="true"]')?.textContent,
    ).toContain('Avoid a null crash');
    expect(
      [...container.querySelectorAll('button')].filter((button) =>
        button.textContent?.includes('Dismiss locally'),
      ),
    ).toHaveLength(2);
    expect(
      container
        .querySelector('button[aria-label^="Show file:"]')
        ?.getAttribute('aria-label'),
    ).toBe('Show file: Avoid a null crash in src/a.ts, additions L2–3');
    expect(
      container
        .querySelector('button[aria-label^="Dismiss locally:"]')
        ?.getAttribute('aria-label'),
    ).toBe('Dismiss locally: Avoid a null crash in src/a.ts, additions L2–3');
  });

  it('names an anchored inspector action with the finding title and location', async () => {
    const onPromote = vi.fn<(finding: NeonReviewFinding) => void>();
    await act(async () => {
      root.render(
        <PrReviewNeonFindingsPanel
          activePath="src/a.ts"
          findings={[finding('active')]}
          isDismissing={() => false}
          onDismiss={vi.fn<(finding: NeonReviewFinding) => void>()}
          onPromote={onPromote}
          onSelect={vi.fn<(finding: NeonReviewFinding) => void>()}
          promoteLabel="Add to local draft"
          promotionDisabledReason={() => null}
          resolutionFor={() => ({
            state: 'anchored',
            lineNumber: 3,
            selection: { side: 'additions', start: 2, end: 3 } as never,
            side: 'additions',
          })}
          selectedAnnotationId={null}
        />,
      );
    });

    expect(
      container
        .querySelector('button[aria-label^="Show finding:"]')
        ?.getAttribute('aria-label'),
    ).toBe('Show finding: Avoid a null crash in src/a.ts, additions L2–3');
    const promoteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Add to local draft:"]',
    );
    expect(promoteButton?.getAttribute('aria-label')).toBe(
      'Add to local draft: Avoid a null crash in src/a.ts, additions L2–3',
    );
    await act(async () =>
      promoteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(onPromote).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'active' }),
    );
  });

  it('disables promotion while an anchor is unavailable and retains destination history', async () => {
    const promoted = finding('promoted');
    await act(async () => {
      root.render(
        <PrReviewNeonFindingsPanel
          activePath="src/a.ts"
          findings={[finding('active'), promoted]}
          isDismissing={() => false}
          isPromoting={() => false}
          onDismiss={vi.fn<(finding: NeonReviewFinding) => void>()}
          onPromote={vi.fn<(finding: NeonReviewFinding) => void>()}
          onSelect={vi.fn<(finding: NeonReviewFinding) => void>()}
          promoteLabel="Request prepared revision"
          promotionDisabledReason={() => 'The patch has not loaded.'}
          resolutionFor={() => ({
            state: 'pending',
            reason: 'The patch has not loaded.',
          })}
          selectedAnnotationId={null}
        />,
      );
    });

    const control = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Request prepared revision:"]',
    );
    expect(control?.disabled).toBe(true);
    expect(control?.title).toBe('The patch has not loaded.');
    expect(container.textContent).toContain(
      'prepared-diff revision request (execution remains separate)',
    );
  });

  it('uses the compact embedded policy without hiding trust provenance', async () => {
    await act(async () => {
      root.render(
        <PrReviewNeonFindingAnnotation
          compact
          finding={finding('active')}
          isDismissing={false}
          onDismiss={vi.fn<(finding: NeonReviewFinding) => void>()}
          selected={false}
        />,
      );
    });

    expect(
      container.querySelector('.pr-review-neon-finding-compact'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Avoid a null crash');
    expect(container.textContent).toContain('model openai/gpt-5');
    expect(container.textContent).toContain('run run-42');
  });
});

function finding(
  state: NeonReviewFinding['lifecycle']['state'],
): NeonReviewFinding {
  return {
    schemaVersion: 2,
    id: state,
    surfaceId: 'surface-a',
    sourceId: 'github-pr:example/repo#42',
    revisionKey: 'git-commit::head-sha',
    file: 'src/a.ts',
    anchor: {
      kind: 'line-range',
      side: 'additions',
      startLine: 2,
      endLine: 3,
    },
    title: 'Avoid a null crash',
    explanation: 'Guard the optional value before reading its property.',
    severity: 'major',
    confidence: 'high',
    suggestedAction: 'Add a guard.',
    provenance: {
      authorRole: 'display-assistant',
      model: 'openai/gpt-5',
      workflowRunId: 'run-42',
      createdAt: '2026-07-18T12:00:00.000Z',
    },
    lifecycle: {
      state,
      changedAt: '2026-07-18T12:00:00.000Z',
      reason: state === 'active' ? null : `${state} by the operator.`,
      promotion:
        state === 'promoted'
          ? {
              destination: 'prepared-diff-revision',
              requestId: 'request-1',
              targetId: 'approval-1',
              containerId: 'prepared-1',
            }
          : null,
    },
  };
}
