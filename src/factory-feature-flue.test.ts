import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { start, sqlite } from '@flue/runtime/node';
import { dispatch, init, type AgentProps } from '@flue/runtime';
import { ensureRuntimeHomeSync, runtimePaths } from './runtime-home';
import { emptyFactorySpec } from '../shared/factory';
import * as factory from './modules/factory';
import { FactoryPlanner, FactoryTriage } from './agents/factory-planner';
import { FactoryReviewer } from './agents/factory-reviewer';
import { FactoryProgressReviewer } from './agents/factory-progress-reviewer';
import { RepoWorkflowProposer } from './modules/repo-workflows/proposal-agent';

const homes: string[] = [];
function fixture(enabled?: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'factory-feature-flue-'));
  homes.push(home);
  vi.stubEnv('NEONDECK_HOME', home);
  const paths = runtimePaths(home);
  ensureRuntimeHomeSync(paths);
  const configure = (factoryEnabled?: boolean) =>
    writeFileSync(
      paths.config,
      JSON.stringify({
        version: 1,
        ...(factoryEnabled === undefined
          ? {}
          : { features: { factory: factoryEnabled } }),
        factory: { enabled: true },
        models: { default: 'faux/faux-1', utility: 'faux/faux-1' },
      }),
    );
  configure(enabled);
  return { paths, configure };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

it.each([undefined, false])(
  'blocks every factory agent before hooks with saved feature %s',
  (enabled) => {
    fixture(enabled);
    // An init-only env var must never override saved config, including legacy files.
    vi.stubEnv('NEONDECK_FACTORY_ENABLED', 'true');
    for (const agent of [
      FactoryPlanner,
      FactoryTriage,
      FactoryReviewer,
      FactoryProgressReviewer,
    ]) {
      expect(() => agent({ id: 'disabled' })).toThrow(
        'Software Factory is disabled',
      );
    }
    expect(() => RepoWorkflowProposer()).toThrow(
      'Software Factory is disabled',
    );
  },
);

it('settles newly accepted factory work without a model or tool call while disabled', async () => {
  fixture(false);
  const provider = fauxProvider();
  const flue = await start({
    agents: [FactoryPlanner, FactoryTriage],
    providers: [provider.provider],
  });
  try {
    for (const agent of [FactoryPlanner, FactoryTriage]) {
      const receipt = await dispatch(agent, {
        id: `disabled-${agent.agentName}`,
        message: 'Queued work',
      });
      await expect(
        init(agent, { id: `disabled-${agent.agentName}` }).read(receipt),
      ).rejects.toMatchObject({
        outcome: 'failed',
        submissionId: receipt.submissionId,
        message: expect.stringContaining('Agent run failed'),
      });
    }
    expect(provider.state.callCount).toBe(0);
  } finally {
    await flue.stop();
  }
});

it('blocks a persisted interrupted durable planner tool on disabled startup and preserves its data', async () => {
  const { paths, configure } = fixture(true);
  const task = factory.submitFactoryWork(
    {
      requestKey: 'recovery',
      title: 'Recovery fixture',
      body: 'Propose a bounded change.',
      repoId: null,
    },
    { kind: 'human', id: 'local-operator' },
    paths,
  );
  const intent = await factory.prepareFactoryPlanning(
    task.work.id,
    { requestKey: 'plan', expectedVersion: 1, message: 'Plan' },
    paths,
  );
  const release =
    Promise.withResolvers<ReturnType<typeof factory.proposeFactorySpec>>();
  const propose = vi
    .spyOn(factory, 'proposeFactorySpec')
    .mockImplementation(() => {
      return release.promise as unknown as ReturnType<
        typeof factory.proposeFactorySpec
      >;
    });
  let renders = 0;
  function Planner(props: AgentProps) {
    renders++;
    return FactoryPlanner(props);
  }
  Planner.agentName = FactoryPlanner.agentName;
  Planner.durability = FactoryPlanner.durability;
  const provider = fauxProvider();
  provider.setResponses([
    () =>
      fauxAssistantMessage(
        [
          fauxToolCall('proposeSpec', {
            expectedVersion: 1,
            expectedSpecVersion: 1,
            expectedRepoFingerprint: null,
            spec: {
              ...emptyFactorySpec(),
              outcome: 'Bounded change',
              scope: 'One task',
              approach: 'One change',
              acceptanceCriteria: [{ id: 'ac-1', text: 'Works.' }],
            },
          }),
        ],
        { stopReason: 'toolUse' },
      ),
    () => fauxAssistantMessage('Done.'),
  ]);
  const liveDb = join(paths.home, 'live.db');
  const interruptedDb = join(paths.home, 'interrupted.db');
  let flue = await start({
    agents: [Planner],
    providers: [provider.provider],
    db: sqlite(liveDb),
  });
  try {
    const receipt = await dispatch(Planner, {
      id: intent.sessionId,
      message: {
        kind: 'signal',
        type: 'neondeck.factory.request',
        attributes: { intentId: intent.id },
        body: 'Plan',
      },
    });
    await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce());
    const db = new DatabaseSync(liveDb);
    try {
      expect(
        db
          .prepare(
            'SELECT status FROM flue_agent_submissions WHERE submission_id=?',
          )
          .get(receipt.submissionId),
      ).toMatchObject({ status: 'running' });
      // Capture a real unresolved durable tool turn, as a process crash would leave it.
      db.prepare('VACUUM INTO ?').run(interruptedDb);
    } finally {
      db.close();
    }
    release.resolve({} as ReturnType<typeof factory.proposeFactorySpec>);
    await init(Planner, { id: intent.sessionId }).read(receipt);
    await flue.stop();
    const snapshot = new DatabaseSync(interruptedDb);
    try {
      snapshot
        .prepare(
          'UPDATE flue_agent_submissions SET lease_expires_at=1 WHERE submission_id=?',
        )
        .run(receipt.submissionId);
    } finally {
      snapshot.close();
    }
    configure(false);
    const callsBefore = provider.state.callCount;
    const rendersBefore = renders;
    propose.mockClear();
    flue = await start({
      agents: [Planner],
      providers: [provider.provider],
      db: sqlite(interruptedDb),
    });
    await vi.waitFor(() => expect(renders).toBeGreaterThan(rendersBefore));
    expect(provider.state.callCount).toBe(callsBefore);
    expect(propose).not.toHaveBeenCalled();
    expect(factory.getFactoryWork(task.work.id, paths).revisions).toHaveLength(
      1,
    );
    const retained = new DatabaseSync(interruptedDb);
    try {
      expect(
        retained
          .prepare(
            'SELECT submission_id FROM flue_agent_submissions WHERE submission_id=?',
          )
          .get(receipt.submissionId),
      ).toBeDefined();
    } finally {
      retained.close();
    }
  } finally {
    release.resolve({} as ReturnType<typeof factory.proposeFactorySpec>);
    await flue.stop();
  }
});
