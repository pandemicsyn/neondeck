// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutopilotPromptControls,
  PrReviewPromptControls,
} from './config-controls';

const prompts = {
  'prepare-only': 'Prepare default {{mode}}',
  'autofix-with-approval': 'Approval default {{mode}}',
  'autofix-push-when-safe': 'Autonomous default {{mode}}',
};

describe('AutopilotPromptControls', () => {
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

  it('edits the full selected mode prompt and explains next-turn behavior', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ prompts, overrides: {} }))
      .mockResolvedValueOnce(
        response({
          prompts: { ...prompts, 'prepare-only': 'My full prompt' },
          overrides: { 'prepare-only': 'My full prompt' },
        }),
      );

    await act(async () => root.render(<AutopilotPromptControls />));
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe(prompts['prepare-only']);
    expect(container.textContent).toContain(
      'Changes apply on the next turn, including existing owners.',
    );

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(textarea, 'My full prompt');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'save',
    ) as HTMLButtonElement;
    await act(async () => save.click());

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/autopilot/prompts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          mode: 'prepare-only',
          prompt: 'My full prompt',
        }),
      }),
    );
    expect(textarea.value).toBe('My full prompt');
  });
});

describe('PrReviewPromptControls', () => {
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

  it('edits the complete initial-review prompt', async () => {
    const reviewPrompts = {
      'initial-review': 'Initial review default',
      'follow-up-reviewer':
        'Follow-up {{workspaceInstructions}} {{reviewContext}}',
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reviewPromptResponse(reviewPrompts, {}))
      .mockResolvedValueOnce(
        reviewPromptResponse(
          { ...reviewPrompts, 'initial-review': 'My reviewer prompt' },
          { 'initial-review': 'My reviewer prompt' },
        ),
      );

    await act(async () => root.render(<PrReviewPromptControls />));
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe(reviewPrompts['initial-review']);
    expect(container.textContent).toContain(
      'Complete replacement system instructions for new review runs.',
    );

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(textarea, 'My reviewer prompt');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'save',
    ) as HTMLButtonElement;
    await act(async () => save.click());

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/pr-review/prompts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          kind: 'initial-review',
          prompt: 'My reviewer prompt',
        }),
      }),
    );
    expect(textarea.value).toBe('My reviewer prompt');
  });
});

function response({
  prompts: responsePrompts,
  overrides,
}: {
  prompts: typeof prompts;
  overrides: Partial<typeof prompts>;
}) {
  return new Response(
    JSON.stringify({
      ok: true,
      action: 'config_read_autopilot_prompts',
      changed: false,
      message: 'Read Autopilot owner prompt templates.',
      home: '/tmp/neondeck',
      files: ['/tmp/neondeck/config.json'],
      data: {
        prompts: responsePrompts,
        defaults: prompts,
        overrides,
        tokens: ['{{mode}}'],
        appliesAfter: 'next-owner-turn',
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

function reviewPromptResponse(
  responsePrompts: Record<'initial-review' | 'follow-up-reviewer', string>,
  overrides: Partial<typeof responsePrompts>,
) {
  return new Response(
    JSON.stringify({
      ok: true,
      action: 'config_read_pr_review_prompts',
      changed: false,
      message: 'Read PR reviewer prompt templates.',
      home: '/tmp/neondeck',
      files: ['/tmp/neondeck/config.json'],
      data: {
        prompts: responsePrompts,
        defaults: responsePrompts,
        overrides,
        tokens: {
          'initial-review': [],
          'follow-up-reviewer': [
            '{{workspaceInstructions}}',
            '{{reviewContext}}',
          ],
        },
        appliesAfter: {
          'initial-review': 'next-review-run',
          'follow-up-reviewer': 'next-reviewer-turn',
        },
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}
