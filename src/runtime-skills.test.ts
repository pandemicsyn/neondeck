import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import {
  listRuntimeSkills,
  loadRuntimeSkill,
  runtimeSkillInstructionsSync,
} from './runtime-skills';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('runtime skills', () => {
  it('seeds and loads the built-in Neondeck runtime skill', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await ensureRuntimeHome(paths);

    expect(existsSync(paths.neondeckSkill)).toBe(true);
    await expect(listRuntimeSkills(paths)).resolves.toMatchObject({
      skills: [
        {
          id: 'neondeck',
          source: 'built-in',
          status: 'active',
        },
      ],
      duplicates: [],
    });

    expect(runtimeSkillInstructionsSync(paths)).toContain(
      'Runtime Skill: neondeck',
    );
  });

  it('discovers user and external skills while ignoring broken folders', async () => {
    const home = await tempDir('neondeck-home-');
    const externalRoot = await tempDir('neondeck-external-skills-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.config,
      `${JSON.stringify({ version: 1, skillRoots: [externalRoot] })}\n`,
    );
    await writeSkill(join(paths.skills, 'repo-guide'), {
      name: 'repo-guide',
      description: 'Explains repo-specific conventions.',
      body: 'Use repo facts before speculation.',
    });
    await mkdir(join(paths.skills, 'broken'), { recursive: true });
    await writeFile(
      join(paths.skills, 'broken', 'SKILL.md'),
      '# Missing metadata\n',
    );
    await writeSkill(join(externalRoot, 'deploy-guide'), {
      name: 'deploy-guide',
      description: 'Explains deploy checks.',
      body: 'Check deploy status before calling work done.',
    });

    const inventory = await listRuntimeSkills(paths);
    expect(inventory.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'neondeck',
          source: 'built-in',
          status: 'active',
        }),
        expect.objectContaining({
          id: 'repo-guide',
          source: 'user',
          status: 'active',
        }),
        expect.objectContaining({
          id: 'deploy-guide',
          source: 'external',
          status: 'active',
        }),
      ]),
    );
    expect(inventory.ignored).toMatchObject([
      {
        source: 'user',
        reason: 'Missing YAML frontmatter.',
      },
    ]);
  });

  it('detects duplicate ids and refuses full loading until resolved', async () => {
    const home = await tempDir('neondeck-home-');
    const externalRoot = await tempDir('neondeck-external-skills-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.config,
      `${JSON.stringify({ version: 1, skillRoots: [externalRoot] })}\n`,
    );
    await writeSkill(join(paths.skills, 'review-guide'), {
      name: 'review-guide',
      description: 'Local review guidance.',
      body: 'Review local changes.',
    });
    await writeSkill(join(externalRoot, 'review-guide'), {
      name: 'review-guide',
      description: 'External review guidance.',
      body: 'Review external changes.',
    });

    const inventory = await listRuntimeSkills(paths);
    expect(inventory.duplicates).toMatchObject([
      {
        id: 'review-guide',
      },
    ]);
    expect(inventory.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'review-guide', status: 'duplicate' }),
      ]),
    );
    await expect(
      loadRuntimeSkill({ id: 'review-guide' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['resolveDuplicateSkill'],
    });
  });

  it('loads full content for one active skill', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeSkill(join(paths.skills, 'ops-guide'), {
      name: 'ops-guide',
      description: 'Operational guidance.',
      body: 'Always check the scheduler state.',
    });

    await expect(
      loadRuntimeSkill({ id: 'ops-guide' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      skill: {
        id: 'ops-guide',
        content: expect.stringContaining('Always check the scheduler state.'),
      },
    });
  });

  it('keeps built-in skills available when external root config is invalid', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(paths.config, '{ "version": "" }\n');

    const inventory = await listRuntimeSkills(paths);
    expect(inventory.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'neondeck', status: 'active' }),
      ]),
    );
    expect(inventory.ignored).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: paths.config })]),
    );
    expect(runtimeSkillInstructionsSync(paths)).toContain(
      'Runtime Skill: neondeck',
    );
  });
});

async function tempDir(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

async function writeSkill(
  directory: string,
  input: { name: string; description: string; body: string },
) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    `---
name: ${input.name}
description: ${input.description}
---

# ${input.name}

${input.body}
`,
  );
}
