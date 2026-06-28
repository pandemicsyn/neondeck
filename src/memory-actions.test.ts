import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteMemory,
  listMemories,
  memoryInstructionsSync,
  upsertMemory,
} from './memory-actions';
import { runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('structured memory actions', () => {
  it('upserts and lists durable scoped memories', async () => {
    const paths = runtimePaths(await tempHome());

    await expect(
      upsertMemory(
        {
          scope: 'user',
          key: 'summary-style',
          value: { preference: 'brief' },
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      appliesAfter: 'new-session',
      message: expect.stringContaining('new session'),
      memory: {
        scope: 'user',
        key: 'summary-style',
        value: { preference: 'brief' },
      },
    });

    await expect(listMemories({ scope: 'user' }, paths)).resolves.toMatchObject(
      {
        ok: true,
        changed: false,
        memories: [
          {
            scope: 'user',
            key: 'summary-style',
            value: { preference: 'brief' },
          },
        ],
      },
    );
  });

  it('updates existing scope/key pairs without duplicating them', async () => {
    const paths = runtimePaths(await tempHome());
    await upsertMemory(
      { scope: 'project', key: 'neondeck.tests', value: 'npm run check' },
      paths,
    );
    await upsertMemory(
      { scope: 'project', key: 'neondeck.tests', value: 'npm run verify' },
      paths,
    );

    const result = await listMemories({ scope: 'project' }, paths);

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({
      scope: 'project',
      key: 'neondeck.tests',
      value: 'npm run verify',
    });
  });

  it('requires confirmation before deleting one memory entry by scope and key', async () => {
    const paths = runtimePaths(await tempHome());
    await upsertMemory(
      { scope: 'session', key: 'current-task', value: 'debug CI' },
      paths,
    );

    await expect(
      deleteMemory({ scope: 'session', key: 'current-task' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['confirm'],
    });

    await expect(
      deleteMemory(
        { scope: 'session', key: 'current-task', confirm: true },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      appliesAfter: 'new-session',
    });
    await expect(listMemories({}, paths)).resolves.toMatchObject({
      memories: [],
    });
  });

  it('renders durable memory instructions for new sessions', async () => {
    const paths = runtimePaths(await tempHome());
    await upsertMemory(
      { scope: 'user', key: 'summary-style', value: 'brief' },
      paths,
    );
    await upsertMemory(
      { scope: 'project', key: 'neondeck.tests', value: 'npm run check' },
      paths,
    );

    const instructions = memoryInstructionsSync(paths);

    expect(instructions).toContain('Structured memory loaded at session start');
    expect(instructions).toContain('- summary-style: brief');
    expect(instructions).toContain('- neondeck.tests: npm run check');
  });

  it('rejects non-JSON-safe memory values', async () => {
    const paths = runtimePaths(await tempHome());

    await expect(
      upsertMemory(
        {
          scope: 'user',
          key: 'bad',
          value: undefined,
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      errors: [expect.stringContaining('Value must be JSON-safe')],
    });
  });
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-memory-'));
  tempRoots.push(home);
  return home;
}
