import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { updateAgentModels } from './config-actions';
import { deleteMemory, upsertMemory } from './memory-actions';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { readNeonSessionState, startNeonSession } from './session-actions';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('session actions', () => {
  it('bootstraps a default active Neon session', async () => {
    const paths = runtimePaths(await tempDir());

    const state = await readNeonSessionState(paths);

    expect(state.ok).toBe(true);
    expect(state.activeSession).toMatchObject({
      id: 'neondeck-main',
      label: 'Primary',
      agentName: 'display-assistant',
      status: 'active',
    });
    expect(state.stale).toBe(false);
    expect(state.history).toHaveLength(1);
  });

  it('starts a new active session and archives the previous one', async () => {
    const paths = runtimePaths(await tempDir());

    const result = await startNeonSession(
      { label: 'After config', reason: 'test-restart' },
      paths,
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      action: 'session_start',
    });
    const state = await readNeonSessionState(paths);
    expect(state.activeSession).toMatchObject({
      label: 'After config',
      reason: 'test-restart',
      status: 'active',
    });
    expect(state.activeSession.id).not.toBe('neondeck-main');
    expect(state.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'neondeck-main',
          status: 'archived',
        }),
      ]),
    );
  });

  it('reports stale context after model config and memory changes', async () => {
    const paths = runtimePaths(await tempDir());
    await startNeonSession({ reason: 'fresh-baseline' }, paths);
    await sleep(5);

    await updateAgentModels({ displayAssistant: 'kilocode/kilo/new' }, paths);
    await upsertMemory(
      { scope: 'user', key: 'summary-style', value: 'brief' },
      paths,
    );

    const state = await readNeonSessionState(paths);

    expect(state.stale).toBe(true);
    expect(state.staleReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'config',
          target: 'models',
        }),
        expect.objectContaining({
          type: 'memory',
          target: 'user:summary-style',
        }),
      ]),
    );
  });

  it('reports stale context after memory deletion', async () => {
    const paths = runtimePaths(await tempDir());
    await upsertMemory(
      { scope: 'session', key: 'current-task', value: 'debug CI' },
      paths,
    );
    await startNeonSession({ reason: 'fresh-after-memory-load' }, paths);
    await sleep(5);

    await deleteMemory(
      { scope: 'session', key: 'current-task', confirm: true },
      paths,
    );

    const state = await readNeonSessionState(paths);

    expect(state.stale).toBe(true);
    expect(state.staleReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'memory',
          target: 'session:current-task',
          message: expect.stringContaining('delete'),
        }),
      ]),
    );
  });

  it('recovers duplicate active sessions by keeping the newest active', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const newer = new Date(Date.now() + 1_000).toISOString();
    const database = new DatabaseSync(paths.neondeckDatabase);
    try {
      database
        .prepare(
          `
          INSERT INTO neon_sessions (
            id,
            label,
            agent_name,
            status,
            created_at,
            activated_at,
            updated_at
          )
          VALUES (?, ?, 'display-assistant', 'active', ?, ?, ?);
        `,
        )
        .run('duplicate-newer', 'Duplicate', newer, newer, newer);
    } finally {
      database.close();
    }

    await ensureRuntimeHome(paths);
    const state = await readNeonSessionState(paths);

    expect(state.activeSession.id).toBe('duplicate-newer');
    expect(state.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'neondeck-main',
          status: 'archived',
        }),
      ]),
    );
  });

  it('rejects invalid new-session labels', async () => {
    const paths = runtimePaths(await tempDir());

    await expect(startNeonSession({ label: '' }, paths)).resolves.toMatchObject(
      {
        ok: false,
        changed: false,
        action: 'session_start',
      },
    );
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-session-'));
  tempRoots.push(path);
  return path;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
