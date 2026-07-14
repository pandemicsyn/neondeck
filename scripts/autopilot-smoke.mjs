import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const home = await mkdtemp(join(tmpdir(), 'neondeck-autopilot-flue-run-'));

try {
  const localApiToken = randomBytes(32).toString('base64url');
  await writeFile(
    join(home, 'config.json'),
    `${JSON.stringify({ version: 1, localApi: { token: localApiToken } })}\n`,
  );
  const input = {
    repoId: 'sample',
    prNumber: 7,
    source: 'fixture',
    autopilotMode: 'prepare-only',
    current: { state: 'open', headSha: 'fixture-head', baseRef: 'main' },
    deltas: [{ type: 'requested-changes', actionable: true }],
  };
  const env = { ...process.env, NEONDECK_HOME: home };
  const run = await execFileAsync(
    'npx',
    [
      'flue',
      'run',
      'workflow:triage-pr-event',
      '--target',
      'node',
      '--server',
      '/api/flue',
      '--header',
      `x-neondeck-api-token: ${localApiToken}`,
      '--input',
      JSON.stringify(input),
    ],
    { cwd: root, env, maxBuffer: 1024 * 1024 },
  );
  const result = parseLastJson(run.stdout);
  assert(
    result?.action === 'autopilot_triage_pr_event',
    'flue run did not return the triage workflow result',
  );
  assert(
    result?.data?.shouldPrepareWorktree === true,
    'triage smoke did not classify the event as worktree-preparable',
  );

  const guardedRun = await execFileAsync(
    'npx',
    [
      'flue',
      'run',
      'workflow:prepare-pr-worktree',
      '--target',
      'node',
      '--server',
      '/api/flue',
      '--header',
      `x-neondeck-api-token: ${localApiToken}`,
      '--input',
      JSON.stringify({ repoId: 'missing-smoke-repo', prNumber: 7 }),
    ],
    { cwd: root, env, maxBuffer: 1024 * 1024 },
  );
  const guardedResult = parseLastJson(guardedRun.stdout);
  assert(
    guardedResult?.action === 'autopilot_prepare_pr_worktree',
    'guarded Flue workflow did not reach the autopilot Action',
  );
  assert(
    guardedResult?.requires?.includes('repo') === true &&
      guardedResult?.requires?.includes('autopilotWorkflow') !== true,
    'Flue workflow runId was not visible to the guarded autopilot Action',
  );

  const marker = join(home, 'flue-run-ok.txt');
  await writeFile(marker, `${result.message}\n`);

  console.log('autopilot smoke passed');
} finally {
  await rm(home, { recursive: true, force: true });
}

function parseLastJson(stdout) {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
