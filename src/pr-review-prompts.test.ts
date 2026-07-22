import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPrReviewAssistantRuntime } from './agents/pr-review-assistant';
import { updatePrReviewPrompt } from './modules/config';
import {
  defaultPrReviewPromptTemplates,
  renderPrReviewPrompt,
  runtimePaths,
} from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('PR review prompts', () => {
  it('uses the configured full prompt for new initial review sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-review-prompts-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);

    expect(buildPrReviewAssistantRuntime(paths).instructions).toBe(
      defaultPrReviewPromptTemplates['initial-review'],
    );

    await updatePrReviewPrompt(
      { kind: 'initial-review', prompt: 'Custom complete review prompt.' },
      paths,
    );

    const runtime = buildPrReviewAssistantRuntime(paths);
    expect(runtime.instructions).toBe('Custom complete review prompt.');
    expect(runtime.skills).toEqual([]);
  });

  it('renders follow-up workspace and review context tokens', () => {
    expect(
      renderPrReviewPrompt('A {{workspaceInstructions}} B {{reviewContext}}', {
        workspaceInstructions: 'workspace-ready',
        reviewContext: '{"review":true}',
      }),
    ).toBe('A workspace-ready B {"review":true}');
  });
});
