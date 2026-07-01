import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveMemory,
  buildMemoryPromptSnapshotSync,
  curateMemoryStore,
  decideMemoryCandidate,
  deleteMemory,
  listMemories,
  listMemoryCandidates,
  listMemoryEvents,
  markMemoriesUsed,
  memoryInstructionsSync,
  mergeMemories,
  rewriteMemory,
  upsertMemory,
} from './memory-actions';
import { updateLearningConfig } from './config-actions';
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
  it('upserts and lists active durable scoped memories', async () => {
    const paths = runtimePaths(await tempHome());

    await expect(
      upsertMemory(
        {
          scope: 'user',
          key: 'summary-style',
          value: { preference: 'brief' },
          reason: 'User correction.',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      appliesAfter: 'new-session',
      memory: {
        scope: 'user',
        key: 'summary-style',
        status: 'active',
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
            status: 'active',
          },
        ],
      },
    );
  });

  it('rejects new session and watch memory writes while keeping old scopes listable', async () => {
    const paths = runtimePaths(await tempHome());

    await expect(
      upsertMemory(
        {
          scope: 'session',
          key: 'current-task',
          value: 'debug CI',
        } as never,
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      errors: [expect.stringContaining('Invalid type')],
    });

    await expect(
      listMemories({ scope: 'session' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      memories: [],
    });
  });

  it('rewrites, merges, archives, and records memory audit events', async () => {
    const paths = runtimePaths(await tempHome());
    const first = await upsertMemory(
      { scope: 'project', key: 'neondeck.tests', value: 'npm run check' },
      paths,
    );
    const second = await upsertMemory(
      { scope: 'local', key: 'node.version', value: 'use Node 26' },
      paths,
    );

    const firstId = (first as { memory?: { id: string } }).memory?.id;
    const secondId = (second as { memory?: { id: string } }).memory?.id;
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();

    await expect(
      rewriteMemory(
        {
          id: firstId!,
          value: 'Use npm run check for the fast loop.',
          reason: 'Make guidance crisp.',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      memory: {
        value: 'Use npm run check for the fast loop.',
      },
    });

    await expect(
      mergeMemories(
        {
          targetId: firstId!,
          sourceIds: [secondId!],
          value:
            'Use Node 26 and npm run check for the Neondeck fast development loop.',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      archivedSourceIds: [secondId],
    });

    await expect(listMemories({}, paths)).resolves.toMatchObject({
      memories: [
        expect.objectContaining({
          id: firstId,
          status: 'active',
        }),
      ],
    });
    await expect(
      listMemories({ includeArchived: true }, paths),
    ).resolves.toMatchObject({
      memories: expect.arrayContaining([
        expect.objectContaining({
          id: secondId,
          status: 'archived',
        }),
      ]),
    });

    await expect(
      archiveMemory({ id: firstId!, reason: 'No longer current.' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      memory: {
        status: 'archived',
      },
    });

    const events = await listMemoryEvents({}, paths);
    expect(events.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'created' }),
        expect.objectContaining({ action: 'rewritten' }),
        expect.objectContaining({ action: 'merged' }),
        expect.objectContaining({ action: 'archived' }),
      ]),
    );
  });

  it('archives through the delete compatibility alias after confirmation', async () => {
    const paths = runtimePaths(await tempHome());
    await upsertMemory({ scope: 'user', key: 'tone', value: 'brief' }, paths);

    await expect(
      deleteMemory({ scope: 'user', key: 'tone' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['confirm'],
    });

    await expect(
      deleteMemory({ scope: 'user', key: 'tone', confirm: true }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      appliesAfter: 'new-session',
    });
    await expect(listMemories({}, paths)).resolves.toMatchObject({
      memories: [],
    });
    await expect(
      listMemories({ includeArchived: true }, paths),
    ).resolves.toMatchObject({
      memories: [expect.objectContaining({ status: 'archived' })],
    });
  });

  it('renders bounded active learning memory instructions for new sessions', async () => {
    const paths = runtimePaths(await tempHome());
    const user = await upsertMemory(
      { scope: 'user', key: 'summary-style', value: 'brief' },
      paths,
    );
    await upsertMemory(
      { scope: 'project', key: 'neondeck.tests', value: 'npm run check' },
      paths,
    );
    await archiveMemory(
      { id: (user as { memory: { id: string } }).memory.id },
      paths,
    );
    await upsertMemory(
      { scope: 'local', key: 'node', value: 'Node 26.4.0' },
      paths,
    );

    const snapshot = buildMemoryPromptSnapshotSync(paths);
    const instructions = memoryInstructionsSync(paths);

    expect(snapshot.memoryIds).toHaveLength(2);
    expect(instructions).toContain('Structured memory loaded at session start');
    expect(instructions).toContain('local:');
    expect(instructions).toContain('- node: Node 26.4.0');
    expect(instructions).toContain('- neondeck.tests: npm run check');
    expect(instructions).not.toContain('summary-style');
  });

  it('marks loaded memories as used without creating stale-context events', async () => {
    const paths = runtimePaths(await tempHome());
    const result = await upsertMemory(
      { scope: 'local', key: 'shell', value: 'zsh' },
      paths,
    );
    const before = await listMemoryEvents({}, paths);

    await expect(
      markMemoriesUsed(
        {
          ids: [(result as { memory: { id: string } }).memory.id],
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      marked: 1,
    });
    await expect(listMemories({}, paths)).resolves.toMatchObject({
      memories: [expect.objectContaining({ useCount: 1 })],
    });
    await expect(listMemoryEvents({}, paths)).resolves.toMatchObject({
      events: before.events,
    });
  });

  it('rejects non-JSON-safe and suspicious memory values with bounded audit', async () => {
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

    await expect(
      upsertMemory(
        {
          scope: 'local',
          key: 'secret',
          value: 'token=abc123',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      errors: [expect.stringContaining('secret')],
    });

    await expect(listMemoryEvents({}, paths)).resolves.toMatchObject({
      events: [expect.objectContaining({ action: 'rejected' })],
    });
  });

  it('creates review-mode curation candidates and applies reviewed decisions', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig(
      {
        memoryMaxActiveItems: 1,
        memoryCurationMode: 'review',
      },
      paths,
    );
    await upsertMemory({ scope: 'local', key: 'first', value: 'one' }, paths);
    await upsertMemory({ scope: 'local', key: 'second', value: 'two' }, paths);

    await expect(
      curateMemoryStore({ mode: 'review' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      mode: 'review',
      candidates: [expect.objectContaining({ action: 'archive' })],
    });

    const candidates = await listMemoryCandidates(
      { status: 'proposed' },
      paths,
    );
    expect(candidates.candidates).toHaveLength(1);
    await expect(
      decideMemoryCandidate(
        { id: candidates.candidates[0]!.id, decision: 'reject' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      decision: 'reject',
    });
  });

  it('enforces learning memory write policy for autonomous mutations', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig(
      {
        memoryWriteMode: 'review',
      },
      paths,
    );

    await expect(
      upsertMemory({ scope: 'local', key: 'auto', value: 'blocked' }, paths, {
        source: 'neon',
      }),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['memory-candidate'],
    });

    await expect(
      upsertMemory({ scope: 'local', key: 'manual', value: 'allowed' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
    });
  });

  it('guards merge replacement values with the suspicious memory filter', async () => {
    const paths = runtimePaths(await tempHome());
    const first = await upsertMemory(
      { scope: 'local', key: 'first', value: 'safe' },
      paths,
    );
    const second = await upsertMemory(
      { scope: 'local', key: 'second', value: 'also safe' },
      paths,
    );

    await expect(
      mergeMemories(
        {
          targetId: (first as { memory: { id: string } }).memory.id,
          sourceIds: [(second as { memory: { id: string } }).memory.id],
          value: 'token=abc123',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      errors: [expect.stringContaining('secret')],
    });
  });

  it('auto curation archives overflow memories only', async () => {
    const paths = runtimePaths(await tempHome());
    await updateLearningConfig(
      {
        memoryMaxActiveItems: 2,
        memoryCurationMode: 'auto',
      },
      paths,
    );
    for (let index = 0; index < 3; index += 1) {
      await upsertMemory(
        {
          scope: 'local',
          key: `item-${index}`,
          value: `value-${index}`,
        },
        paths,
      );
    }

    await expect(
      curateMemoryStore({ mode: 'auto' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      mode: 'auto',
      applied: [expect.objectContaining({ action: 'memory_archive' })],
    });
    await expect(listMemories({}, paths)).resolves.toMatchObject({
      memories: expect.arrayContaining([
        expect.objectContaining({ status: 'active' }),
      ]),
    });
    await expect(
      listMemories({ includeArchived: true }, paths),
    ).resolves.toMatchObject({
      memories: expect.arrayContaining([
        expect.objectContaining({ status: 'archived' }),
      ]),
    });
  });
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-memory-'));
  tempRoots.push(home);
  return home;
}
