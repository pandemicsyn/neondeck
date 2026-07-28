import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultOpenAiCodexModel } from '../model-defaults';
import { updateAgentModels } from '../modules/config';
import { readNeonSessionState } from '../modules/sessions';
import { ensureRuntimeHome, runtimePaths } from '../runtime-home';
import {
  defaultProviderModel,
  finalizeFreshInstallSession,
  formatOnboardingNextSteps,
  formatRuntimeSkillRootsNote,
  hasPackagedServerEntry,
} from './onboarding';

const tempRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('onboarding session baseline', () => {
  it('rebaselines only a session created for a fresh installation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-24T12:00:00.000Z');
    const home = await mkdtemp(join(tmpdir(), 'neondeck-onboarding-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);

    vi.setSystemTime('2026-07-24T12:00:01.000Z');
    await updateAgentModels({ displayAssistant: 'openai/gpt-5.5' }, paths);
    await expect(readNeonSessionState(paths)).resolves.toMatchObject({
      stale: true,
    });

    vi.setSystemTime('2026-07-24T12:00:02.000Z');
    await finalizeFreshInstallSession(paths, true);
    await expect(readNeonSessionState(paths)).resolves.toMatchObject({
      activeSessionId: 'neondeck-main',
      stale: false,
      staleReasons: [],
    });

    vi.setSystemTime('2026-07-24T12:00:03.000Z');
    await updateAgentModels(
      { displayAssistant: 'anthropic/claude-sonnet-4-6' },
      paths,
    );
    await finalizeFreshInstallSession(paths, false);
    await expect(readNeonSessionState(paths)).resolves.toMatchObject({
      activeSessionId: 'neondeck-main',
      stale: true,
    });
  });
});

describe('runtime skill root onboarding', () => {
  it('explains the always-on local root when no external roots are selected', () => {
    expect(formatRuntimeSkillRootsNote('/runtime/skills', []))
      .toMatchInlineSnapshot(`
      "Local root (always scanned): /runtime/skills
      External roots: none
      Example external root: ~/.agents/skills (auto-detected when present)
      Expected layout: <root>/<skill-name>/SKILL.md
      Bundled Neondeck skills load automatically."
    `);
  });

  it('lists configured and selected external roots', () => {
    expect(
      formatRuntimeSkillRootsNote('/runtime/skills', [
        '/Users/alice/.agents/skills',
        '/opt/team-skills',
      ]),
    ).toContain(
      'External roots:\n  /Users/alice/.agents/skills\n  /opt/team-skills',
    );
  });
});

describe('onboarding model defaults', () => {
  it('uses the latest ChatGPT subscription model without changing API defaults', () => {
    expect(defaultProviderModel('openai-codex')).toBe(defaultOpenAiCodexModel);
    expect(defaultProviderModel('openai')).toBe('openai/gpt-5.5');
    expect(defaultProviderModel('openrouter')).toBe(
      'openrouter/openai/gpt-5.5',
    );
  });
});

describe('onboarding next steps', () => {
  it('points packaged installs to the production server commands', () => {
    expect(formatOnboardingNextSteps(true, 'cloud')).toEqual([
      '',
      'Next:',
      '  neondeck service install',
      '  neondeck open',
      '',
      'Optional diagnostics:',
      '  neondeck doctor --repo cloud',
    ]);
  });

  it('keeps source checkout development guidance', () => {
    expect(formatOnboardingNextSteps(false)).toEqual([
      '',
      'Next:',
      '  npm run dev',
      '  open http://127.0.0.1:5173/',
    ]);
  });

  it('recognizes an explicit packaged server entry', () => {
    expect(
      hasPackagedServerEntry({
        NEONDECK_SERVER_ENTRY: import.meta.filename,
      }),
    ).toBe(true);
  });
});
