import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRuntimeHomeSync, runtimePaths } from '../../../runtime-home';
import type {
  GitHubConnection,
  GitHubIssue,
} from '../../../../shared/factory-github';
export const connection: GitHubConnection = {
  id: 'synthetic',
  enabled: true,
  repoId: 'fixture',
  repositoryId: '42',
  owner: 'example',
  name: 'fixture',
  webhookSecretEnv: 'FACTORY_TEST_WEBHOOK',
  tokenEnv: 'FACTORY_TEST_TOKEN',
  admission: { mode: 'label', label: 'factory' },
};
export const issue: GitHubIssue = {
  id: 101,
  number: 1,
  title: 'Synthetic issue',
  body: 'Complete source body',
  state: 'open',
  updated_at: '2026-09-01T00:00:00Z',
  user: { login: 'fixture-author' },
  labels: [{ name: 'factory' }],
};
export function fixture() {
  const paths = runtimePaths(
    mkdtempSync(join(tmpdir(), 'factory-github-test-')),
  );
  ensureRuntimeHomeSync(paths);
  process.env.FACTORY_TEST_WEBHOOK = 'synthetic-webhook-fixture-only';
  process.env.FACTORY_TEST_TOKEN = 'synthetic-read-fixture-only';
  const config = (connections = [connection]) =>
    writeFileSync(
      paths.config,
      JSON.stringify({
        version: 1,
        factory: { enabled: true, github: connections },
        models: { default: 'faux/faux-1' },
      }),
    );
  config();
  writeFileSync(
    paths.repos,
    JSON.stringify({
      version: 1,
      repos: [
        {
          id: 'fixture',
          path: paths.home,
          github: { owner: 'example', name: 'fixture' },
          defaultBranch: 'main',
        },
      ],
    }),
  );
  return {
    paths,
    config,
    dispose: () => {
      rmSync(paths.home, { recursive: true, force: true });
      delete process.env.FACTORY_TEST_WEBHOOK;
      delete process.env.FACTORY_TEST_TOKEN;
    },
  };
}
