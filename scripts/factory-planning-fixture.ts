/** Synthetic screenshot server. Uses real factory services and Flue with a
 * deterministic test provider; never reads operator configuration/credentials. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { start, sqlite } from '@flue/runtime/node';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
const home = mkdtempSync(join(tmpdir(), 'factory-ui-synthetic-'));
process.env.NEONDECK_HOME = home;
const { runtimePaths, ensureRuntimeHomeSync } =
  await import('../src/runtime-home/index');
const paths = runtimePaths(home);
ensureRuntimeHomeSync(paths);
writeFileSync(
  paths.config,
  JSON.stringify({
    version: 1,
    factory: { enabled: true },
    models: { default: 'faux/faux-1', utility: 'faux/faux-1' },
  }),
);
const repo = join(home, 'demo-repository');
mkdirSync(repo);
writeFileSync(
  join(repo, 'README.md'),
  '# Demo task inbox\nTasks have a title and durable status.\n',
);
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
git('init');
git('add', '.');
git(
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.test',
  '-c',
  'commit.gpgsign=false',
  'commit',
  '-m',
  'Synthetic fixture',
);
writeFileSync(
  paths.repos,
  JSON.stringify({
    version: 1,
    repos: [
      {
        id: 'demo',
        path: repo,
        defaultBranch: 'main',
        github: { owner: 'example', name: 'demo-inbox' },
      },
    ],
  }),
);
const { FactoryPlanner, FactoryTriage } =
  await import('../src/agents/factory-planner');
const factory = await import('../src/modules/factory/index');
const { emptyFactorySpec } = await import('../shared/factory');
const provider = fauxProvider();
provider.setResponses(
  Array.from({ length: 100 }, () => (context) => {
    const input = JSON.stringify(context);
    const intent = factory
      .pendingPlanningIntents(paths)
      .find((i) => input.includes(i.id));
    if (!intent) return fauxAssistantMessage('No active synthetic request.');
    if (intent.stage === 'triage') {
      if (intent.snapshot.source.title.includes('Triage failure'))
        return fauxAssistantMessage(
          [
            fauxToolCall('submitTriage', {
              disposition: 'invalid-fixture-result',
            }),
          ],
          { stopReason: 'toolUse' },
        );
      return fauxAssistantMessage(
        [
          fauxToolCall('submitTriage', {
            disposition: 'implement',
            summary:
              'A bounded title filter fits this repository. Confirm matching behavior before release.',
            priority: 'normal',
            missingInformation: ['Should title matching ignore case?'],
            candidateIds: [],
          }),
        ],
        { stopReason: 'toolUse' },
      );
    }
    const current = factory.getFactoryWork(intent.workId, paths);
    if (current.work.specVersion > intent.snapshot.work.specVersion)
      return fauxAssistantMessage(
        current.work.specVersion > 2
          ? 'I saved revision 3. Matching now ignores case, and clearing the query restores every task. The brief is ready for your review.'
          : 'I saved a proposed brief with a small local filter and three acceptance checks. Should matching ignore case? Your answer will become a new revision.',
      );
    const revised = current.work.specVersion > 1;
    return fauxAssistantMessage(
      [
        fauxToolCall('proposeSpec', {
          expectedVersion: current.work.version,
          expectedSpecVersion: current.work.specVersion,
          expectedRepoFingerprint: current.repoFingerprint,
          spec: {
            ...emptyFactorySpec(),
            outcome:
              'Find a saved task by its title without leaving the Factory inbox.',
            scope:
              'A local title filter above the inbox list. Preserve the selected task and its unsaved edits.',
            nonGoals:
              'No remote search, relevance ranking, new source integration, or coding executor.',
            approach: revised
              ? 'Filter the existing inbox list as the user types. Compare normalized lowercase titles and queries. Clearing the query restores the full list.'
              : 'Add a labelled search field above the existing task list. Filter loaded task titles locally and show a clear empty state when nothing matches.',
            acceptanceCriteria: [
              {
                id: 'ac-1',
                text: 'Typing a title fragment shows matching tasks.',
              },
              {
                id: 'ac-2',
                text: revised
                  ? 'Matching ignores letter case.'
                  : 'Clearing the query restores all tasks.',
              },
              { id: 'ac-3', text: 'Filtering preserves unsaved draft edits.' },
            ],
            constraints:
              'Reuse the current inbox and keyboard-accessible controls.',
            assumptions:
              'The inbox contains enough loaded titles for a local filter.',
            decisions: [
              {
                id: 'matching-case',
                question: 'Should title matching ignore case?',
                blocking: true,
                answer: revised
                  ? 'Yes — confirmed by the human in this conversation.'
                  : null,
              },
            ],
          },
        }),
      ],
      { stopReason: 'toolUse' },
    );
  }),
);
const flue = await start({
  agents: [FactoryPlanner, FactoryTriage],
  providers: [provider.provider],
  db: sqlite(join(home, 'fixture-flue.db')),
});
const actor = { kind: 'human' as const, id: 'local-operator' };
const main = factory.submitFactoryWork(
  {
    requestKey: 'fixture-main',
    title: 'Filter the Factory inbox by title',
    body: 'Synthetic evidence — deterministic test model. Help users find a task quickly while preserving their current draft.',
    repoId: 'demo',
  },
  actor,
  paths,
);
const triage = factory.prepareFactoryTriage(main.work.id, paths)!;
await factory.resumeFactoryPlanning(triage.id, paths);
const draft = factory.prepareFactoryPlanning(
  main.work.id,
  {
    requestKey: 'fixture-plan',
    expectedVersion: 1,
    message:
      'Please propose a small, accessible inbox filter and ask about any scope decision.',
  },
  paths,
);
await factory.resumeFactoryPlanning(draft.id, paths);
const failure = factory.submitFactoryWork(
  {
    requestKey: 'fixture-error',
    title: 'Triage failure — synthetic retry example',
    body: 'Synthetic invalid classifier output demonstrates the retry and manual-edit path.',
    repoId: 'demo',
  },
  actor,
  paths,
);
const failureIntent = factory.prepareFactoryTriage(failure.work.id, paths)!;
await factory.resumeFactoryPlanning(failureIntent.id, paths);
const { createFactoryRoutes } = await import('../src/server/routes/factory');
const { createFactoryPlannerRoutes } =
  await import('../src/server/routes/factory-planner');
const { requireLocalApiAccess } = await import('../src/server/middleware');
const app = new Hono();
app.use('/api/*', requireLocalApiAccess());
app.route('/api/factory', createFactoryRoutes(paths));
app.route(
  '/api/flue/agents/factory-planner',
  createFactoryPlannerRoutes(paths),
);
app.get('/api/session', (c) => c.json({}));
app.get('/api/sessions/:id/activity', (c) => c.json({ items: [] }));
app.get('/api/sessions/:id/command-events', (c) => c.json({ events: [] }));
app.get('/api/local-api/session', (c) => c.json({ enabled: false }));
app.get('/api/*', (c) => c.json({}));
const root = resolve('web/dist');
app.use('/assets/*', serveStatic({ root }));
app.get('*', serveStatic({ root, path: 'index.html' }));
const port = Number(process.env.FACTORY_FIXTURE_PORT ?? 4192);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
console.info(
  JSON.stringify({
    fixture: 'deterministic-test-model',
    port,
    mainTaskId: main.work.id,
    failureTaskId: failure.work.id,
  }),
);
process.on('SIGTERM', () => {
  server.close();
  void flue.stop().then(() => process.exit(0));
});
