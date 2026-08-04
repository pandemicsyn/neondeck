import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { init, observe, type FlueObservation } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DisplayAssistant } from './agents/display-assistant';
import {
  attachBriefingDispatch,
  briefingContextModelWasAdopted,
  createBriefingRun,
  readBriefingRun,
  settleBriefingObservation,
} from './modules/briefings';
import { createChatSession, readChatSession } from './modules/sessions';
import { openDb } from './lib/sqlite';
import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
} from './runtime-home';

const tempRoots: string[] = [];
const originalHome = process.env.NEONDECK_HOME;

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

afterEach(async () => {
  if (originalHome === undefined) delete process.env.NEONDECK_HOME;
  else process.env.NEONDECK_HOME = originalHome;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it('validates an exact briefing run before advancing display context', async () => {
  const { home, paths, sessionId } = await briefingFixture();
  process.env.NEONDECK_HOME = home;
  await configureDisplayModel(paths.config, 'faux/faux-1');
  markBriefingSessionStale(paths.neondeckDatabase, sessionId, 'model');
  const faux = fauxProvider();
  const flue = await start({
    agents: [DisplayAssistant],
    providers: [faux.provider],
  });
  try {
    const handle = init(DisplayAssistant, { id: sessionId });
    const receipt = await handle.dispatch({
      message: briefingSignal('missing-briefing-run'),
    });
    await expect(handle.read(receipt)).rejects.toThrow('Agent run failed');

    const database = openDb(paths.neondeckDatabase, { readOnly: true });
    const row = database
      .prepare('SELECT context_snapshot_id FROM chat_sessions WHERE id = ?;')
      .get(sessionId) as { context_snapshot_id: string | null };
    database.close();
    expect(row.context_snapshot_id).toBeNull();
    await expect(
      readChatSession({ id: sessionId }, paths),
    ).resolves.toMatchObject({
      session: { staleReasons: [expect.objectContaining({ type: 'model' })] },
    });
  } finally {
    await flue.stop();
  }
});

it('settles joined briefing context only after the exact response adopts it', async () => {
  const { home, paths, sessionId } = await briefingFixture();
  process.env.NEONDECK_HOME = home;
  await configureDisplayModel(paths.config, 'faux-briefing/old');
  const modelContexts: string[] = [];
  const faux = fauxProvider({
    provider: 'faux-briefing',
    models: [
      { id: 'old', reasoning: false },
      { id: 'new', reasoning: false },
    ],
    tokensPerSecond: 20,
  });
  faux.setResponses([
    (context) => {
      modelContexts.push(JSON.stringify(context));
      return fauxAssistantMessage(
        'I am finishing the response that began with the old display model. '.repeat(
          3,
        ),
      );
    },
    (context) => {
      modelContexts.push(JSON.stringify(context));
      return fauxAssistantMessage('Joined briefing answered.');
    },
    (context) => {
      modelContexts.push(JSON.stringify(context));
      return fauxAssistantMessage('Later joined user delivery answered.');
    },
    (context) => {
      modelContexts.push(JSON.stringify(context));
      return fauxAssistantMessage('Retry used its durable briefing context.');
    },
    (context) => {
      modelContexts.push(JSON.stringify(context));
      return fauxAssistantMessage('Fresh briefing response answered.');
    },
    (context) => {
      modelContexts.push(JSON.stringify(context));
      return fauxAssistantMessage('Post-fence briefing response answered.');
    },
  ]);

  const flue = await start({
    agents: [DisplayAssistant],
    providers: [faux.provider],
  });
  const handle = init(DisplayAssistant, { id: sessionId });
  let resolveFirstTurn!: () => void;
  const firstTurn = new Promise<void>((resolve) => {
    resolveFirstTurn = resolve;
  });
  const unsubscribe = observe((event) => {
    if (
      event.type === 'turn_start' &&
      event.agentName === 'display-assistant' &&
      event.instanceId === sessionId
    ) {
      resolveFirstTurn();
    }
  });
  try {
    const ordinaryReceipt = await handle.dispatch(
      'Start an ordinary response.',
    );
    const ordinaryRead = handle.read(ordinaryReceipt);
    await firstTurn;

    await configureDisplayModel(paths.config, 'faux-briefing/new');
    markBriefingSessionStale(paths.neondeckDatabase, sessionId, 'model');
    const joinedRun = await createQueuedBriefingRun(paths, sessionId);
    const joinedReceipt = await handle.dispatch({
      message: briefingSignal(joinedRun.id),
    });
    const laterReceipt = await handle.dispatch(
      'A later delivery joins after the briefing signal.',
    );
    await attachBriefingDispatch(
      joinedRun.id,
      joinedReceipt.submissionId,
      paths,
    );
    const [, joinedReply] = await Promise.all([
      ordinaryRead,
      handle.read(joinedReceipt),
      handle.read(laterReceipt),
    ]);
    const joinedBoundRun = await readBriefingRun(joinedRun.id, paths);
    expect(joinedBoundRun).toMatchObject({
      contextBinding: {
        refreshRequired: true,
        model: 'faux-briefing/new',
        thinkingLevel: 'low',
      },
    });
    expect(
      briefingContextModelWasAdopted(
        joinedReply.metadata,
        joinedBoundRun!.contextBinding!,
      ),
    ).toBe(false);

    await configureDisplayModel(paths.config, 'faux-briefing/old');
    const replayReceipt = await handle.dispatch({
      message: briefingSignal(joinedRun.id),
    });
    const replayReply = await handle.read(replayReceipt);
    expect(
      briefingContextModelWasAdopted(
        replayReply.metadata,
        joinedBoundRun!.contextBinding!,
      ),
    ).toBe(true);
    await configureDisplayModel(paths.config, 'faux-briefing/new');

    await settleCompletedBriefing(sessionId, joinedReceipt.submissionId, paths);
    await expect(readBriefingRun(joinedRun.id, paths)).resolves.toMatchObject({
      status: 'ready',
      contextSnapshotId: joinedBoundRun?.contextSnapshotId,
    });
    await expect(
      readChatSession({ id: sessionId }, paths),
    ).resolves.toMatchObject({
      session: { staleReasons: [expect.objectContaining({ type: 'model' })] },
    });

    const adoptedRun = await createQueuedBriefingRun(paths, sessionId);
    const adoptedReceipt = await handle.dispatch({
      message: briefingSignal(adoptedRun.id),
    });
    await attachBriefingDispatch(
      adoptedRun.id,
      adoptedReceipt.submissionId,
      paths,
    );
    const adoptedReply = await handle.read(adoptedReceipt);
    const adoptedBoundRun = await readBriefingRun(adoptedRun.id, paths);
    expect(
      briefingContextModelWasAdopted(
        adoptedReply.metadata,
        adoptedBoundRun!.contextBinding!,
      ),
    ).toBe(true);
    mutateSessionContextAfterCapture(paths.neondeckDatabase, sessionId);
    await settleCompletedBriefing(
      sessionId,
      adoptedReceipt.submissionId,
      paths,
    );
    await expect(readBriefingRun(adoptedRun.id, paths)).resolves.toMatchObject({
      status: 'ready',
    });
    await expect(
      readChatSession({ id: sessionId }, paths),
    ).resolves.toMatchObject({
      session: {
        linkedRepoId: 'repo-after-capture',
        staleReasons: [expect.objectContaining({ type: 'model' })],
      },
    });

    const finalRun = await createQueuedBriefingRun(paths, sessionId);
    const finalReceipt = await handle.dispatch({
      message: briefingSignal(finalRun.id),
    });
    await attachBriefingDispatch(finalRun.id, finalReceipt.submissionId, paths);
    await handle.read(finalReceipt);
    await settleCompletedBriefing(sessionId, finalReceipt.submissionId, paths);
    await expect(
      readChatSession({ id: sessionId }, paths),
    ).resolves.toMatchObject({ session: { staleReasons: [] } });
    expect(modelContexts).toHaveLength(5);
  } finally {
    unsubscribe();
    await flue.stop();
  }
});

async function briefingFixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-display-flue-'));
  tempRoots.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  const created = await createChatSession(
    { title: 'Mounted briefing lifecycle', kind: 'briefing' },
    paths,
  );
  if (!('session' in created) || !created.session) {
    throw new Error('Briefing session fixture was not created.');
  }
  return { home, paths, sessionId: created.session.id };
}

async function configureDisplayModel(configPath: string, model: string) {
  const config = await readRuntimeJson(configPath, parseAppConfig);
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        models: {
          ...config.models,
          displayAssistant: model,
          displayAssistantThinkingLevel: 'low',
        },
      },
      null,
      2,
    )}\n`,
  );
}

function markBriefingSessionStale(
  databasePath: string,
  sessionId: string,
  type: 'model',
) {
  const database = openDb(databasePath);
  database
    .prepare('UPDATE chat_sessions SET context_loaded_at = ? WHERE id = ?;')
    .run('2000-01-01T00:00:00.000Z', sessionId);
  database
    .prepare(
      `INSERT INTO config_history (
        action, file, target, before_json, after_json, changed_at
      ) VALUES (?, ?, ?, ?, ?, ?);`,
    )
    .run(
      'config_update_agent_models',
      'config.json',
      type === 'model' ? 'models' : type,
      '{}',
      '{}',
      new Date().toISOString(),
    );
  database.close();
}

function mutateSessionContextAfterCapture(
  databasePath: string,
  sessionId: string,
) {
  const database = openDb(databasePath);
  database
    .prepare(
      `UPDATE chat_sessions
       SET linked_repo_id = ?, updated_at = ?
       WHERE id = ?;`,
    )
    .run('repo-after-capture', new Date().toISOString(), sessionId);
  database.close();
}

async function createQueuedBriefingRun(
  paths: ReturnType<typeof runtimePaths>,
  sessionId: string,
) {
  const run = await createBriefingRun(
    {
      profileId: 'morning',
      trigger: 'manual',
      snapshot: {
        version: 1,
        collectedAt: new Date().toISOString(),
        byteSize: 2,
        truncated: false,
        sources: {},
      },
      instructions: 'Summarize the mounted lifecycle fixture.',
      instructionsVersion: 1,
      sessionId,
    },
    paths,
  );
  if (!run) throw new Error('Briefing run fixture was not created.');
  return run;
}

function briefingSignal(runId: string) {
  return {
    kind: 'signal' as const,
    type: 'neondeck.briefing.ready',
    tagName: 'morning-briefing',
    body: `Persisted briefing ${runId} is ready for grounded delivery.`,
    attributes: {
      briefingRunId: runId,
      profileId: 'morning',
      snapshotVersion: '1',
    },
  };
}

async function settleCompletedBriefing(
  sessionId: string,
  submissionId: string,
  paths: ReturnType<typeof runtimePaths>,
) {
  await settleBriefingObservation(
    {
      type: 'submission_settled',
      v: 3,
      eventIndex: 1,
      timestamp: new Date().toISOString(),
      agentName: 'display-assistant',
      instanceId: sessionId,
      submissionId,
      outcome: 'completed',
    } as Extract<FlueObservation, { type: 'submission_settled' }>,
    paths,
  );
}
