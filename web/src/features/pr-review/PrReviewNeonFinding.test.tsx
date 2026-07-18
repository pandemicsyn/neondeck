// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import {
  PrReviewNeonFindingAnnotation,
  PrReviewNeonFindingsPanel,
} from './PrReviewNeonFinding';

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
          selectedAnnotationId="active"
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
    schemaVersion: 1,
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
    },
  };
}
