import { beforeEach, expect, it, vi } from 'vitest';
import { runtimePaths } from '../../runtime-home';
vi.mock('../../modules/repo-workflows', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../modules/repo-workflows')>();
  return {
    ...actual,
    readRepoWorkflows: vi.fn(),
    saveRepoWorkflows: vi.fn(),
    proposeRepoWorkflows: vi.fn(),
  };
});
import {
  readRepoWorkflows,
  saveRepoWorkflows,
  proposeRepoWorkflows,
  RepoWorkflowError,
} from '../../modules/repo-workflows';
import { createRepoWorkflowsRoutes } from './repo-workflows';
const paths = runtimePaths('/tmp/fixture-workflows');
const snapshot = {
  repoId: 'example',
  fingerprint: 'a'.repeat(64),
  workflows: null,
};
beforeEach(() => vi.resetAllMocks());
it('exposes read and forwards the exact save body for domain CAS validation', async () => {
  vi.mocked(readRepoWorkflows).mockReturnValue(snapshot);
  vi.mocked(saveRepoWorkflows).mockReturnValue(snapshot);
  const app = createRepoWorkflowsRoutes(paths);
  expect(
    await (await app.request('/repos/example/factory-workflows')).json(),
  ).toEqual(snapshot);
  const body = { expectedFingerprint: snapshot.fingerprint, workflows: null };
  expect(
    (
      await app.request('/repos/example/factory-workflows', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(200);
  expect(saveRepoWorkflows).toHaveBeenCalledWith('example', body, paths);
});
it('maps missing and stale context to typed statuses and malformed JSON to 400', async () => {
  const app = createRepoWorkflowsRoutes(paths);
  vi.mocked(readRepoWorkflows).mockImplementation(() => {
    throw new RepoWorkflowError('missing', 404);
  });
  expect((await app.request('/repos/missing/factory-workflows')).status).toBe(
    404,
  );
  vi.mocked(saveRepoWorkflows).mockImplementation(() => {
    throw new RepoWorkflowError('reload', 409);
  });
  expect(
    (
      await app.request('/repos/example/factory-workflows', {
        method: 'PUT',
        body: '{}',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await app.request('/repos/example/factory-workflows', {
        method: 'PUT',
        body: '{',
      })
    ).status,
  ).toBe(400);
});
it('proposal failure never falls through to save or exposes provider internals', async () => {
  vi.mocked(proposeRepoWorkflows).mockRejectedValue(
    new Error('private provider configuration'),
  );
  const app = createRepoWorkflowsRoutes(paths);
  const result = await app.request('/repos/example/factory-workflows/propose', {
    method: 'POST',
    body: JSON.stringify({ expectedFingerprint: snapshot.fingerprint }),
  });
  expect(result.status).toBe(500);
  expect(JSON.stringify(await result.json())).not.toContain('private');
  expect(saveRepoWorkflows).not.toHaveBeenCalled();
});

it.each([
  ['PUT', '/repos/example/factory-workflows'],
  ['POST', '/repos/example/factory-workflows/propose'],
])(
  'rejects oversized %s body with 413 before domain parsing or model invocation',
  async (method, path) => {
    const app = createRepoWorkflowsRoutes(paths);
    const body = JSON.stringify({ oversized: 'x'.repeat(1024 * 1024) });
    for (const headers of [
      new Headers({ 'content-type': 'application/json' }),
      new Headers({
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      }),
    ]) {
      const response = await app.request(path, { method, headers, body });
      expect(response.status).toBe(413);
    }
    expect(saveRepoWorkflows).not.toHaveBeenCalled();
    expect(proposeRepoWorkflows).not.toHaveBeenCalled();
  },
);
