import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord } from './modules/app-state';
import { runIssueTriageJob } from './modules/issue-triage';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const originalFetch = globalThis.fetch;
const originalGitHubToken = process.env.GITHUB_TOKEN;
const tempRoots: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalGitHubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalGitHubToken;
  }
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('issue triage job', () => {
  it('does not regress the watermark when updated old issues are returned', async () => {
    const previousWatermark = '2026-07-05T12:00:00.000Z';
    const oldIssue = issue({
      number: 7,
      createdAt: '2026-06-01T12:00:00.000Z',
      updatedAt: '2026-07-05T13:00:00.000Z',
    });
    const seenUrls: string[] = [];
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      seenUrls.push(url);
      return jsonResponse([oldIssue]);
    });
    process.env.GITHUB_TOKEN = 'test-token';
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.repos,
      JSON.stringify({
        repos: [
          {
            id: 'sample',
            github: { owner: 'pandemicsyn', name: 'sample' },
            path: '/tmp/sample',
            defaultBranch: 'main',
          },
        ],
      }),
    );

    const result = await runIssueTriageJob(
      job(
        {
          repo: 'sample',
          limit: 20,
        },
        {
          watermark: previousWatermark,
          recentIssueNumbers: [],
        },
      ),
      paths,
    );

    expect(result).toMatchObject({
      outcome: 'silent',
      result: {
        watermark: previousWatermark,
        previousWatermark,
        counts: {
          new: 0,
        },
      },
    });
    expect(
      seenUrls.some((url) => {
        const parsed = new URL(url);
        return (
          parsed.searchParams.get('sort') === 'created' &&
          parsed.searchParams.get('since') === previousWatermark
        );
      }),
    ).toBe(true);
  });
});

function job(
  config: Record<string, unknown>,
  lastResult: Record<string, unknown> | null = null,
): JobRecord {
  const now = new Date().toISOString();
  return {
    id: 'schedule:issues',
    type: 'issue-triage',
    blueprint: 'issue-triage',
    enabled: true,
    intervalSeconds: 600,
    config: config as JobRecord['config'],
    nextRunAt: now,
    lastRunAt: null,
    lastOutcome: null,
    lastMessage: null,
    lastResult: lastResult as JobRecord['lastResult'],
    createdAt: now,
    updatedAt: now,
  };
}

function issue(input: {
  number: number;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    number: input.number,
    title: 'Documented issue with enough detail',
    html_url: `https://github.com/pandemicsyn/sample/issues/${input.number}`,
    body: 'Repro steps are available. Expected behavior and actual behavior are documented with environment details.',
    user: { login: 'reporter' },
    assignees: [],
    labels: [],
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    comments: 0,
  };
}

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-issue-triage-'));
  tempRoots.push(path);
  return path;
}
