#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const origin = readStringArg('--origin', 'http://127.0.0.1:3000');
const repo = requiredStringArg('--repo');
const number = readPositiveIntegerArg('--number');
const head = requiredStringArg('--head');
const base = requiredStringArg('--base');
const baseRef = readStringArg('--base-ref', 'main');
const title = readStringArg('--title', `${repo}#${number}`);
const samples = readPositiveIntegerArg('--samples', 3);
const includeGitHubFallback = args.includes('--include-github-fallback');
const allowDevelopment = args.includes('--allow-development');
const outPath = readStringArg(
  '--out',
  'benchmarks/results/pr-review-real-local.json',
);
const [owner, name] = parseRepo(repo);
const target = { repo, number, head, base, baseRef, title };

const serverMode = await inspectServer(origin);
if (serverMode === 'development' && !allowDevelopment) {
  throw new Error(
    `${origin} is serving the Vite development client. Run npm run build:dashboard followed by npm start, or pass --allow-development for a diagnostic run.`,
  );
}

const initialAuto = await measureJson(fileListUrl('auto'));
const files = initialAuto.json.data?.files ?? [];
if (files.length === 0) {
  throw new Error(
    initialAuto.json.message ?? 'The PR file-list response contained no files.',
  );
}

const warmFileList = await repeat(samples, () =>
  measureJson(fileListUrl('auto')),
);
const activeFile =
  files.find((file) => !file.binary && !file.truncated && file.changes > 0) ??
  files[0];
const activeIndex = files.findIndex((file) => file.path === activeFile.path);
const warmFirstPatch = await repeat(samples, () =>
  measureJson(fileDiffUrl(activeFile.path, 'auto')),
);
const initialThreads = await measureJson(
  `${origin}/api/github/prs/review-threads`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo, prNumber: number }),
  },
);
const warmReviewThreads = await repeat(samples, () =>
  measureJson(`${origin}/api/github/prs/review-threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo, prNumber: number }),
  }),
);
const threadData = initialThreads.json.data ?? {};
const reviewThreads = threadData.reviewThreads ?? [];
const unresolvedReviewThreads =
  threadData.unresolvedReviewThreads ??
  reviewThreads.filter((thread) => !thread.isResolved);
const unresolvedPaths = unresolvedReviewThreads
  .map((thread) => thread.path ?? thread.comments?.[0]?.path)
  .filter(Boolean);
const fanoutPaths = [
  activeFile.path,
  files[activeIndex - 1]?.path,
  files[activeIndex + 1]?.path,
  ...unresolvedPaths,
].filter((path, index, paths) => path && paths.indexOf(path) === index);
const fanoutStartedAt = performance.now();
const fanoutRequests = await Promise.all(
  fanoutPaths.map((path) => measureJson(fileDiffUrl(path, 'auto'))),
);
const concurrentFanout = {
  paths: fanoutPaths,
  wallMs: performance.now() - fanoutStartedAt,
  requests: fanoutRequests.map(requestSummary),
};

const githubFallback = includeGitHubFallback
  ? {
      first: requestSummary(await measureJson(fileListUrl('github'))),
      cached: requestSummary(await measureJson(fileListUrl('github'))),
    }
  : null;

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-precise-memory-info'],
});
let browserSamples;
try {
  browserSamples = await repeat(samples, () =>
    measureBrowserReview(browser, {
      origin,
      target,
      threadCount: reviewThreads.length,
    }),
  );
} finally {
  await browser.close();
}

const output = {
  version: 3,
  generatedAt: new Date().toISOString(),
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    browser: 'Playwright Chromium',
    origin,
    serverMode,
    samples,
    note: 'Machine-local real-PR evidence; not a CI performance gate.',
  },
  target: {
    ...target,
    fileCount: files.length,
    additions: initialAuto.json.data?.diffSummary?.additions ?? null,
    deletions: initialAuto.json.data?.diffSummary?.deletions ?? null,
    reviewThreads: reviewThreads.length,
    unresolvedReviewThreads: unresolvedReviewThreads.length,
  },
  budgets: {
    warmTreeVisibleMs: 500,
    warmFirstPatchMs: 1_000,
    warmThreadsVisibleMs: 500,
    coldLocalFetchMs: 3_000,
  },
  backend: {
    initialAuto: {
      ...requestSummary(initialAuto),
      warning:
        'This is cold only when the target head/base objects were absent before the run.',
    },
    warmFileList: aggregateRequests(warmFileList),
    warmFirstPatch: {
      path: activeFile.path,
      ...aggregateRequests(warmFirstPatch),
    },
    reviewThreads: {
      initial: {
        ...requestSummary(initialThreads),
        warning:
          'This is cold only when the in-process review-thread cache was empty before the run.',
      },
      warm: aggregateRequests(warmReviewThreads),
      total: reviewThreads.length,
      unresolved: unresolvedReviewThreads.length,
      unresolvedPaths: [...new Set(unresolvedPaths)],
    },
    concurrentFanout,
    githubFallback,
  },
  browser: {
    samples: browserSamples,
    aggregate: aggregateBrowserSamples(browserSamples),
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
console.log(`WROTE ${outPath}`);

function fileListUrl(source) {
  const url = new URL(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${number}/files`,
    origin,
  );
  appendRevision(url);
  url.searchParams.set('patches', 'none');
  url.searchParams.set('source', source);
  return url.toString();
}

function fileDiffUrl(path, source) {
  const url = new URL(
    `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${number}/files/diff`,
    origin,
  );
  appendRevision(url);
  url.searchParams.set('source', source);
  url.searchParams.set('path', path);
  return url.toString();
}

function appendRevision(url) {
  url.searchParams.set('head', head);
  url.searchParams.set('base', base);
  url.searchParams.set('baseRef', baseRef);
}

async function measureJson(url, init) {
  const startedAt = performance.now();
  const response = await fetch(url, init);
  const buffer = await response.arrayBuffer();
  const text = new TextDecoder().decode(buffer);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Expected JSON from ${url}, received ${text.slice(0, 120)}`,
    );
  }
  if (!response.ok || json.ok === false) {
    throw new Error(json.message ?? `Request failed with ${response.status}.`);
  }
  return {
    elapsedMs: performance.now() - startedAt,
    status: response.status,
    bytes: buffer.byteLength,
    json,
  };
}

async function measureBrowserReview(
  browserInstance,
  { origin: browserOrigin, target: browserTarget, threadCount },
) {
  const context = await browserInstance.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  const failedApiRequests = [];
  page.on('requestfailed', (request) => {
    if (!request.url().includes('/api/github/')) return;
    failedApiRequests.push({
      url: request.url(),
      errorText: request.failure()?.errorText ?? 'unknown',
    });
  });
  const url = new URL('/review', browserOrigin);
  url.searchParams.set('repo', browserTarget.repo);
  url.searchParams.set('number', String(browserTarget.number));
  url.searchParams.set('head', browserTarget.head);
  url.searchParams.set('base', browserTarget.base);
  url.searchParams.set('baseRef', browserTarget.baseRef);
  url.searchParams.set('title', browserTarget.title);

  await page.addInitScript(
    ({ expectedThreadCount }) => {
      const state = {
        treeVisibleMs: 0,
        firstPatchMs: 0,
        threadsVisibleMs: 0,
        lcpMs: 0,
        cls: 0,
        longTasks: [],
      };
      window.__NEONDECK_REAL_PR_PERF__ = state;
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        state.lcpMs = entries[entries.length - 1]?.startTime ?? state.lcpMs;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) state.cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((list) => {
        state.longTasks.push(
          ...list.getEntries().map((entry) => entry.duration),
        );
      }).observe({ type: 'longtask', buffered: true });
      const check = () => {
        const now = performance.now();
        const tree = document.querySelector('file-tree-container');
        const patch = document.querySelector('.diff-patch');
        if (
          !state.treeVisibleMs &&
          tree?.shadowRoot?.querySelectorAll('[role="treeitem"]').length
        ) {
          state.treeVisibleMs = now;
        }
        if (
          !state.firstPatchMs &&
          patch?.shadowRoot?.querySelector('[data-line-type]')
        ) {
          state.firstPatchMs = now;
        }
        const body = document.body?.innerText ?? '';
        if (
          !state.threadsVisibleMs &&
          body.includes(`/${expectedThreadCount}`) &&
          body.includes('threads')
        ) {
          state.threadsVisibleMs = now;
        }
        if (!(
          state.treeVisibleMs &&
          state.firstPatchMs &&
          state.threadsVisibleMs
        )) {
          requestAnimationFrame(check);
        }
      };
      addEventListener('DOMContentLoaded', () => requestAnimationFrame(check), {
        once: true,
      });
    },
    { expectedThreadCount: threadCount },
  );

  try {
    await page.goto(url.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.waitForFunction(
      () => {
        const state = window.__NEONDECK_REAL_PR_PERF__;
        return Boolean(
          state?.treeVisibleMs && state.firstPatchMs && state.threadsVisibleMs,
        );
      },
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(3_000);
    const browserResult = await page.evaluate(() => {
      const state = window.__NEONDECK_REAL_PR_PERF__;
      const resources = performance
        .getEntriesByType('resource')
        .filter((entry) => entry.name.includes('/api/github/'));
      const patchRequests = resources.filter((entry) =>
        entry.name.includes('/files/diff?'),
      );
      const threadRequests = resources.filter((entry) =>
        entry.name.endsWith('/review-threads'),
      );
      const firstContentfulPaint = performance.getEntriesByName(
        'first-contentful-paint',
      )[0];
      const threadResponseEndMs = Math.max(
        0,
        ...threadRequests.map((entry) => entry.responseEnd),
      );
      return {
        treeVisibleMs: state.treeVisibleMs,
        firstPatchMs: state.firstPatchMs,
        threadsVisibleMs: state.threadsVisibleMs,
        fcpMs: firstContentfulPaint?.startTime ?? 0,
        lcpMs: state.lcpMs,
        cls: state.cls,
        longTaskCount: state.longTasks.length,
        longTaskTotalMs: state.longTasks.reduce(
          (sum, duration) => sum + duration,
          0,
        ),
        apiRequestCount: resources.length,
        apiTransferBytes: resources.reduce(
          (sum, entry) => sum + entry.transferSize,
          0,
        ),
        threadRequestCount: threadRequests.length,
        threadTransferBytes: threadRequests.reduce(
          (sum, entry) => sum + entry.transferSize,
          0,
        ),
        threadEncodedBodyBytes: threadRequests.reduce(
          (sum, entry) => sum + entry.encodedBodySize,
          0,
        ),
        threadRequestStartMs:
          threadRequests.length > 0
            ? Math.min(...threadRequests.map((entry) => entry.startTime))
            : 0,
        threadResponseEndMs,
        threadRequestDurationMs: Math.max(
          0,
          ...threadRequests.map((entry) => entry.duration),
        ),
        threadRenderAfterResponseMs:
          threadResponseEndMs > 0
            ? Math.max(0, state.threadsVisibleMs - threadResponseEndMs)
            : 0,
        patchRequestCount: patchRequests.length,
        patchRequestsStartedBeforeFirstPatch: patchRequests.filter(
          (entry) => entry.startTime < state.firstPatchMs,
        ).length,
        lastApiResponseMs: Math.max(
          0,
          ...resources.map((entry) => entry.responseEnd),
        ),
      };
    });
    const abortedRequests = failedApiRequests.filter((request) =>
      request.errorText.includes('ERR_ABORTED'),
    );
    return {
      ...browserResult,
      failedApiRequestCount: failedApiRequests.length,
      abortedApiRequestCount: abortedRequests.length,
      abortedThreadRequestCount: abortedRequests.filter((request) =>
        request.url.endsWith('/review-threads'),
      ).length,
      abortedPatchRequestCount: abortedRequests.filter((request) =>
        request.url.includes('/files/diff?'),
      ).length,
    };
  } finally {
    await context.close();
  }
}

function aggregateRequests(requests) {
  return {
    samples: requests.map(requestSummary),
    medianMs: percentile(
      requests.map((request) => request.elapsedMs),
      0.5,
    ),
    p95Ms: percentile(
      requests.map((request) => request.elapsedMs),
      0.95,
    ),
  };
}

function aggregateBrowserSamples(browserResults) {
  return Object.fromEntries(
    [
      'treeVisibleMs',
      'firstPatchMs',
      'threadsVisibleMs',
      'fcpMs',
      'lcpMs',
      'cls',
      'longTaskCount',
      'longTaskTotalMs',
      'apiRequestCount',
      'apiTransferBytes',
      'threadRequestCount',
      'threadTransferBytes',
      'threadEncodedBodyBytes',
      'threadRequestStartMs',
      'threadResponseEndMs',
      'threadRequestDurationMs',
      'threadRenderAfterResponseMs',
      'patchRequestCount',
      'patchRequestsStartedBeforeFirstPatch',
      'failedApiRequestCount',
      'abortedApiRequestCount',
      'abortedThreadRequestCount',
      'abortedPatchRequestCount',
      'lastApiResponseMs',
    ].map((key) => [
      key,
      {
        median: percentile(
          browserResults.map((result) => result[key]),
          0.5,
        ),
        min: Math.min(...browserResults.map((result) => result[key])),
        max: Math.max(...browserResults.map((result) => result[key])),
      },
    ]),
  );
}

function requestSummary(request) {
  return {
    elapsedMs: request.elapsedMs,
    status: request.status,
    bytes: request.bytes,
    source: request.json.data?.source ?? null,
    fileCount: request.json.data?.files?.length ?? null,
    truncatedFiles:
      request.json.data?.files?.filter((file) => file.truncated).length ?? null,
  };
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  ];
}

async function repeat(count, fn) {
  const values = [];
  for (let index = 0; index < count; index += 1) values.push(await fn(index));
  return values;
}

async function inspectServer(serverOrigin) {
  const response = await fetch(serverOrigin);
  if (!response.ok) {
    throw new Error(`${serverOrigin} returned ${response.status}.`);
  }
  const html = await response.text();
  return html.includes('/@vite/client') ? 'development' : 'production';
}

function parseRepo(value) {
  const parts = value.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`--repo must use owner/name format, received ${value}.`);
  }
  return parts;
}

function requiredStringArg(name) {
  const value = readStringArg(name, '');
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readStringArg(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function readPositiveIntegerArg(name, fallback) {
  const raw = readStringArg(name, fallback ? String(fallback) : '');
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
