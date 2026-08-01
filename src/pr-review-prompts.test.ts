import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPrReviewAssistantRuntime } from './agents/pr-review-assistant';
import { buildPrReviewerRuntime } from './agents/pr-reviewer';
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
    expect(defaultPrReviewPromptTemplates['initial-review']).toContain(
      'This bounded review submission does not permit task delegation: do not call the generic task tool or start a child review.',
    );

    await updatePrReviewPrompt(
      { kind: 'initial-review', prompt: 'Custom complete review prompt.' },
      paths,
    );

    const runtime = buildPrReviewAssistantRuntime(paths);
    expect(runtime.instructions).toBe('Custom complete review prompt.');
    expect(runtime.skills).toEqual([]);
    const environment = await runtime.sandbox.createSessionEnv({
      id: 'initial-review',
    });
    expect(runtime.sandbox.tools?.(environment, { subagents: {} })).toEqual([]);
  });

  it('suppresses generic sandbox tools for continuing reviewer sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-review-prompts-'));
    tempRoots.push(home);
    const runtime = await buildPrReviewerRuntime(
      'missing-review-record',
      runtimePaths(home),
    );
    const environment = await runtime.sandbox.createSessionEnv({
      id: 'follow-up-review',
    });

    expect(runtime.sandbox.tools?.(environment, { subagents: {} })).toEqual([]);
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
