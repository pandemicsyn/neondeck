// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubPrReviewDraft, PrReviewRecord } from '../../api';

const queries = vi.hoisted(() => ({
  useGitHubPrReviewDraft: vi.fn(),
}));
const briefingActionHook = vi.hoisted(() => ({
  usePrReviewBriefingActions: vi.fn(),
}));

vi.mock('./queries', () => ({
  prReviewDraftQueryOptions: (review: PrReviewRecord) => ({
    draftId:
      review.status === 'submitting' || review.status === 'submitted'
        ? review.submissionDraftId
        : null,
    live: review.status === 'ready',
    submissionStatus:
      review.status === 'submitting' || review.status === 'submitted'
        ? review.status
        : null,
  }),
  useGitHubPrReviewDraft: queries.useGitHubPrReviewDraft,
}));
vi.mock('./usePrReviewBriefingActions', () => ({
  usePrReviewBriefingActions: briefingActionHook.usePrReviewBriefingActions,
}));

import { PrReviewBriefingOverlay, PrReviewBriefing } from './PrReviewBriefing';

describe('PR review briefing', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
    queries.useGitHubPrReviewDraft.mockReturnValue({
      data: draftFixture(),
      error: null,
      isLoading: false,
    });
    briefingActionHook.usePrReviewBriefingActions.mockReturnValue(
      actionFixture(),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('opens the record-fed overlay, reads its live draft, and wires pop-out', () => {
    const onClose = vi.fn<() => void>();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const review = reviewFixture('approve');
    act(() =>
      root.render(
        <PrReviewBriefingOverlay onClose={onClose} review={review} />,
      ),
    );

    expect(queries.useGitHubPrReviewDraft).toHaveBeenCalledWith(
      {
        repo: 'owner/repo',
        number: 1,
      },
      { draftId: null, live: true, submissionStatus: null },
    );
    expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    act(() =>
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === 'pop out')
        ?.click(),
    );
    expect(open).toHaveBeenCalledWith(
      '/review-briefing?id=review-1',
      'neondeck-review-briefing-review-1',
      'popup,width=1440,height=920',
    );
    act(() =>
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === 'close')
        ?.click(),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders an approval briefing from the persisted overview and live draft', () => {
    renderBriefing(root, reviewFixture('approve'), draftFixture());

    expect(container.textContent).toContain('REVIEW BRIEFING');
    expect(container.textContent).toContain('approve');
    expect(container.textContent).toContain('Why this is safe');
    expect(container.textContent).not.toContain('Live draft body');
    expect(container.textContent).toContain('Guard the empty response.');
    expect(container.textContent).toContain(
      'Fallback behavior needs a manual check.',
    );
    expect(container.textContent).toContain('minor');
    expect(container.textContent).toContain('note-only');
    expect(container.textContent).toContain('Change map');
    expect(container.textContent).toContain('Got a question?');
    expect(
      [...container.querySelectorAll<HTMLAnchorElement>('a')]
        .find((link) => link.textContent === 'Ask Neon in the workbench →')
        ?.getAttribute('href'),
    ).toBe('/review?repo=owner%2Frepo&number=1');
    act(() =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          '[aria-expanded=false]',
        ),
      ].forEach((button) => button.click()),
    );
    expect(container.textContent).toContain('Live draft body');
    expect(
      [...container.querySelectorAll('a')].filter(
        (link) => link.textContent === 'open in diff',
      ),
    ).toHaveLength(2);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('puts blockers first and warns when the live draft revision moved', () => {
    const review = reviewFixture('needs-human');
    const draft = draftFixture();
    draft.headSha = 'different-head';
    draft.comments.unshift({
      ...draft.comments[0]!,
      id: 'blocker',
      body: 'Blocking draft body',
      neonSeverity: 'major',
    });
    renderBriefing(root, review, draft);

    expect(container.textContent).toContain('needs human review');
    expect(container.textContent).toContain('What makes this hard');
    expect(container.textContent).toContain('Why I’m escalating');
    expect(container.textContent).toContain('differen');
    expect(container.textContent?.indexOf('src/fallback.ts')).toBeLessThan(
      container.textContent?.indexOf('Blocking draft body') ?? 0,
    );
    expect(container.textContent).not.toContain('Live draft body');
    expect(
      [...container.querySelectorAll<HTMLAnchorElement>('a')]
        .find((link) => link.textContent === 'Open workbench →')
        ?.getAttribute('href'),
    ).toBe('/review?repo=owner%2Frepo&number=1');
    act(() =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'everything')
        ?.click(),
    );
    expect(container.textContent).not.toContain('Live draft body');
    act(() =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          '[aria-expanded=false]',
        ),
      ]
        .find((button) => button.textContent?.includes('draft comment'))
        ?.click(),
    );
    expect(container.textContent).toContain('Live draft body');
  });

  it('does not invent a severity for human-authored comments', () => {
    const draft = draftFixture();
    draft.comments[0] = {
      ...draft.comments[0]!,
      origin: 'human',
      neonSeverity: null,
      neonSummary: null,
    };
    renderBriefing(root, reviewFixture('approve'), draft);

    expect(container.textContent).toContain('comment');
    expect(container.textContent).not.toContain('minor');
  });

  it('keeps a promoted blocker in the draft queue without double-counting it', () => {
    const review = reviewFixture('needs-human');
    review.reportOnlyFindings[0] = {
      ...review.reportOnlyFindings[0]!,
      line: 24,
      side: 'RIGHT',
    };
    const draft = draftFixture();
    draft.comments.push({
      ...draft.comments[0]!,
      id: 'promoted-comment',
      path: 'src/fallback.ts',
      line: 24,
      body: 'Human-adjusted promoted comment.',
      sourceFindingId: 'finding-2',
      neonSeverity: null,
      neonSummary: null,
    });
    renderBriefing(root, review, draft);

    expect(container.textContent).toContain('2 live drafts · 0 note-only');
    expect(container.textContent).toContain('1 blocker needs a decision');
    expect(container.textContent).toContain('Human-adjusted promoted comment.');
    expect(
      container.textContent?.split('Fallback behavior needs a manual check.')
        .length,
    ).toBe(2);
  });

  it('keeps live draft counts unknown while the draft is loading or unavailable', () => {
    act(() =>
      root.render(
        <PrReviewBriefing
          draft={undefined}
          draftLoading
          review={reviewFixture('approve')}
        />,
      ),
    );
    expect(container.textContent).toContain('— live drafts');
    expect(container.textContent).not.toContain('0 live drafts');

    act(() =>
      root.render(
        <PrReviewBriefing
          draft={undefined}
          draftError={new Error('offline')}
          review={reviewFixture('approve')}
        />,
      ),
    );
    expect(container.textContent).toContain('draft unavailable: offline');
    expect(container.textContent).toContain('— live drafts');

    act(() =>
      root.render(
        <PrReviewBriefing
          draft={draftFixture()}
          draftError={new Error('refresh failed')}
          review={reviewFixture('approve')}
        />,
      ),
    );
    expect(container.textContent).toContain(
      'draft unavailable: refresh failed',
    );
    expect(container.textContent).toContain('— live drafts');
    expect(container.textContent).not.toContain('Live draft body');
    expect(container.textContent).toContain('Draft state is unavailable');
  });

  it('renders submitted reviews as linked receipts', () => {
    const review = reviewFixture('approve');
    review.status = 'submitted';
    review.verdict = 'approve';
    review.githubReviewUrl = 'https://github.com/owner/repo/pull/1#review-1';
    review.submittedAt = '2026-08-22T19:00:00.000Z';
    renderBriefing(root, review, draftFixture());

    expect(container.textContent).toContain('submitted · approve');
    expect(container.textContent).toContain('Submitted as approve');
    expect(
      container.querySelector<HTMLAnchorElement>('a[href*="#review-1"]')
        ?.textContent,
    ).toBe('view GitHub receipt');
    expect(container.textContent).not.toContain(
      'Briefing ready for your final check',
    );
  });

  it('loads the exact persisted submission draft for a receipt overlay', () => {
    const review = reviewFixture('approve');
    review.status = 'submitted';
    review.submissionDraftId = 'draft-1';
    act(() =>
      root.render(
        <PrReviewBriefingOverlay onClose={vi.fn()} review={review} />,
      ),
    );

    expect(queries.useGitHubPrReviewDraft).toHaveBeenCalledWith(
      { repo: 'owner/repo', number: 1 },
      {
        draftId: 'draft-1',
        live: false,
        submissionStatus: 'submitted',
      },
    );
  });

  it('offers explicit recovery while a submission is uncertain', async () => {
    const review = reviewFixture('approve');
    review.status = 'submitting';
    const actions = actionFixture();
    const draft = { ...draftFixture(), status: 'submitting' as const };
    renderBriefing(root, review, draft, actions);

    await act(async () =>
      buttonWithText(container, 'recover submission').click(),
    );

    expect(actions.recoverSubmission).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Submitting this review to GitHub');
  });

  it('wires edit, dismiss, note promotion, and approval through briefing actions', async () => {
    const actions = actionFixture();
    const review = reviewFixture('needs-human');
    review.reportOnlyFindings[0] = {
      ...review.reportOnlyFindings[0]!,
      line: 24,
      side: 'RIGHT',
    };
    await act(async () =>
      root.render(
        <PrReviewBriefing
          actions={actions}
          draft={draftFixture()}
          review={review}
        />,
      ),
    );
    act(() =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'everything')
        ?.click(),
    );

    const draftToggle = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('draft comment'),
    );
    act(() => draftToggle?.click());
    act(() =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'edit comment')
        ?.click(),
    );
    const draftEditor = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label^="Edit draft comment"]',
    );
    act(() => setTextareaValue(draftEditor, 'Human-edited comment'));
    await act(async () =>
      draftEditor
        ?.closest('form')
        ?.dispatchEvent(
          new SubmitEvent('submit', { bubbles: true, cancelable: true }),
        ),
    );
    expect(actions.editComment).toHaveBeenCalledWith(
      'comment-1',
      'Human-edited comment',
    );

    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'dismiss')
        ?.click(),
    );
    expect(actions.dismissComment).toHaveBeenCalledWith('comment-1');

    act(() =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'draft a comment from this')
        ?.click(),
    );
    const findingEditor = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label^="Draft a comment from note"]',
    );
    act(() => setTextareaValue(findingEditor, 'Human-adjusted note'));
    await act(async () =>
      findingEditor
        ?.closest('form')
        ?.dispatchEvent(
          new SubmitEvent('submit', { bubbles: true, cancelable: true }),
        ),
    );
    expect(actions.promoteFinding).toHaveBeenCalledWith(
      review.reportOnlyFindings[0],
      'Human-adjusted note',
    );

    expect(
      [...container.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('approve anyway & submit'),
      ),
    ).toBe(false);
    act(() => buttonWithText(container, 'approve anyway').click());
    expect(container.textContent).toContain(
      'Nothing is sent until you press the submit button.',
    );
    const approvalNote = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Approval note"]',
    );
    act(() => setTextareaValue(approvalNote, 'Reviewed by a human.'));
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) =>
          button.textContent?.includes('approve anyway & submit'),
        )
        ?.click(),
    );
    expect(actions.submitApproval).toHaveBeenCalledWith('Reviewed by a human.');
  });

  it('names the optional approval note in the submission payload', () => {
    const actions = actionFixture();
    renderBriefing(root, reviewFixture('approve'), draftFixture(), actions);

    expect(container.textContent).toContain('approve & submit 1 comment');
    const note = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Approval note"]',
    );
    act(() => setTextareaValue(note, '   '));
    expect(container.textContent).toContain('approve & submit 1 comment');
    act(() => setTextareaValue(note, 'Reviewed manually.'));
    expect(container.textContent).toContain(
      'approve & submit note + 1 comment',
    );
    expect(container.textContent).toContain('with note + 1 comment, as you');
    expect(container.textContent).toContain('Open workbench instead');
  });

  it('warns when a rejected draft comment will be omitted', () => {
    const actions = actionFixture();
    actions.rejectedCommentCount = 1;
    renderBriefing(root, reviewFixture('approve'), draftFixture(), actions);

    expect(container.textContent).toContain(
      'approve & submit 0 comments · 1 rejected draft omitted until edited',
    );
  });

  it('does not label a local draft mutation as a GitHub submission', () => {
    const actions = actionFixture();
    actions.busy = true;
    renderBriefing(root, reviewFixture('approve'), draftFixture(), actions);

    expect(container.textContent).toContain('draft update in progress…');
    expect(container.textContent).not.toContain('submitting…');
  });

  it('announces a failed card mutation', async () => {
    const actions = actionFixture();
    actions.dismissComment.mockRejectedValueOnce(new Error('draft moved'));
    renderBriefing(root, reviewFixture('approve'), draftFixture(), actions);
    act(() =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          '[aria-expanded=false]',
        ),
      ]
        .find((button) => button.textContent?.includes('draft comment'))
        ?.click(),
    );
    await act(async () => buttonWithText(container, 'dismiss').click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'draft moved',
    );
  });

  it('keeps an archived ready briefing read-only and explains how to continue', () => {
    const review = reviewFixture('approve');
    review.archivedAt = '2026-08-22T18:30:00.000Z';

    renderBriefing(root, review, draftFixture(), actionFixture());

    expect(container.textContent).toContain(
      'Restore it from the review queue before changing its draft or submitting an approval.',
    );
    expect(
      buttonWithText(container, 'approve & submit 1 comment').disabled,
    ).toBe(true);
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === 'dismiss',
      ),
    ).toBe(false);
  });
});

function actionFixture() {
  return {
    busy: false,
    rejectedCommentCount: 0,
    submitting: false,
    dismissComment: vi.fn(async () => undefined),
    editComment: vi.fn(async () => undefined),
    promoteFinding: vi.fn(async () => undefined),
    recoverSubmission: vi.fn(async () => undefined),
    submitApproval: vi.fn(async () => undefined),
  };
}

function setTextareaValue(textarea: HTMLTextAreaElement | null, value: string) {
  if (!textarea) throw new Error('Expected textarea.');
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function renderBriefing(
  root: ReturnType<typeof createRoot>,
  review: PrReviewRecord,
  draft: GitHubPrReviewDraft,
  actions?: ReturnType<typeof actionFixture>,
) {
  act(() =>
    root.render(
      <PrReviewBriefing actions={actions} draft={draft} review={review} />,
    ),
  );
}

function buttonWithText(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function reviewFixture(
  recommendation: 'approve' | 'needs-human',
): PrReviewRecord {
  const now = '2026-08-22T18:00:00.000Z';
  return {
    id: 'review-1',
    ref: 'owner/repo#1',
    repoFullName: 'owner/repo',
    prNumber: 1,
    title: 'Keep the review decision close to the evidence',
    author: 'octocat',
    prUrl: 'https://github.com/owner/repo/pull/1',
    status: 'ready',
    runId: 'run-1',
    headSha: 'head123456789',
    baseSha: 'base123',
    baseRef: 'main',
    origin: 'panel',
    reviewUrl: '/review?repo=owner%2Frepo&number=1',
    reportIds: [],
    recommendation,
    recommendationReason:
      recommendation === 'approve'
        ? 'The guarded change is supported by focused tests.'
        : 'A major finding requires human review.',
    briefingOverview: {
      schemaVersion: 1,
      recommendation,
      recommendationReason:
        recommendation === 'approve'
          ? 'The guarded change is supported by focused tests.'
          : 'A major finding requires human review.',
      summary: '**The path is bounded.** Existing behavior stays intact.',
      changeMap: [{ path: 'src/app.ts', summary: 'Adds the guarded branch.' }],
      risks: ['Confirm the fallback path on an empty response.'],
    },
    findingCount: 2,
    seededCount: 1,
    reportOnlyCount: 1,
    reportOnlyFindings: [
      {
        sourceId: 'finding-2',
        severity: recommendation === 'needs-human' ? 'critical' : 'nit',
        path: 'src/fallback.ts',
        line: null,
        summary: 'Fallback behavior needs a manual check.',
        suggestedFix: 'Exercise the empty response case.',
        reason: 'No exact changed line is available.',
      },
    ],
    trustBoundary: 'No review is submitted until you act.',
    verdict: null,
    previousVerdict: null,
    githubReviewUrl: null,
    failureMessage: null,
    createdAt: now,
    updatedAt: now,
    readyAt: now,
    submittedAt: null,
    failedAt: null,
    archivedAt: null,
  };
}

function draftFixture(): GitHubPrReviewDraft {
  const now = '2026-08-22T18:00:00.000Z';
  return {
    id: 'draft-1',
    repo: 'owner/repo',
    prNumber: 1,
    headSha: 'head123456789',
    verdict: null,
    body: null,
    status: 'draft',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    submittedAt: null,
    comments: [
      {
        id: 'comment-1',
        draftId: 'draft-1',
        path: 'src/app.ts',
        side: 'RIGHT',
        line: 12,
        startLine: null,
        startSide: null,
        body: 'Live draft body',
        origin: 'neon',
        sourceFindingId: 'finding-1',
        neonSeverity: 'minor',
        neonSummary: 'Guard the empty response.',
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}
