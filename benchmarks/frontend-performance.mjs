#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const samples = readPositiveIntegerArg('--samples', 1);
const includeFiftyK = args.includes('--include-fifty-k');
const skipBuild = args.includes('--skip-build');
const outPath = readStringArg(
  '--out',
  'benchmarks/results/frontend-performance-local.json',
);
const baseUrl = 'http://127.0.0.1:4179';

const scenarios = [
  scenario('diff/typical/baseline', 'diff', 'typical'),
  scenario('diff/large/baseline', 'diff', 'large', { timeoutMs: 60_000 }),
  scenario('diff/huge/baseline', 'diff', 'huge', { timeoutMs: 90_000 }),
  scenario('diff/huge/virtualized', 'diff', 'huge', {
    variant: 'virtualized',
    timeoutMs: 90_000,
  }),
  scenario('diff/tree/baseline', 'diff', 'tree', { timeoutMs: 60_000 }),
  scenario('diff/threads/baseline', 'diff', 'threads'),
  scenario('diff/wrapped/baseline', 'diff', 'wrapped'),
  scenario('chat/10', 'chat', '10'),
  scenario('chat/100', 'chat', '100'),
  scenario('chat/500', 'chat', '500', { timeoutMs: 60_000 }),
  scenario('chat/10/isolated', 'chat', '10', { variant: 'isolated' }),
  scenario('chat/100/isolated', 'chat', '100', { variant: 'isolated' }),
  scenario('chat/500/isolated', 'chat', '500', {
    variant: 'isolated',
    timeoutMs: 60_000,
  }),
  scenario('runtime/1', 'runtime', '1'),
  scenario('runtime/2', 'runtime', '2'),
  scenario('runtime/4', 'runtime', '4'),
  scenario('review/desktop/50', 'review', '50', {
    viewport: { width: 1440, height: 900 },
  }),
  scenario('review/narrow/50', 'review', '50', {
    viewport: { width: 430, height: 850 },
  }),
];

if (includeFiftyK) {
  scenarios.push(
    scenario('diff/fifty-k/baseline', 'diff', 'fifty-k', {
      timeoutMs: 240_000,
    }),
    scenario('diff/fifty-k/virtualized', 'diff', 'fifty-k', {
      variant: 'virtualized',
      timeoutMs: 240_000,
    }),
  );
}

if (!skipBuild) {
  run('npm', ['run', 'build:web']);
  run('npm', ['run', 'bench:frontend:build']);
} else if (!existsSync('web/dist-perf/perf.html')) {
  throw new Error(
    'web/dist-perf/perf.html is missing; omit --skip-build first.',
  );
}

const bundle = measureProductionBundle();
const server = startPreviewServer();

try {
  await waitForServer(`${baseUrl}/perf.html`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-precise-memory-info'],
  });
  const results = [];

  try {
    for (const definition of scenarios) {
      const scenarioSamples = [];
      for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
        const result = await measureScenario(browser, definition, sampleIndex);
        scenarioSamples.push(result);
        console.log(
          `METRIC ${definition.name} sample=${sampleIndex + 1} load_ms=${result.loadToQuietMs.toFixed(2)} dom_nodes=${result.domNodes} heap_mb=${bytesToMb(result.usedJsHeapBytes).toFixed(2)}`,
        );
      }
      results.push({
        name: definition.name,
        fixture: scenarioSamples[0]?.fixture ?? {},
        samples: scenarioSamples,
        aggregate: aggregateSamples(scenarioSamples),
      });
    }
  } finally {
    await browser.close();
  }

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      browser: 'Playwright Chromium',
      viewport: 'scenario-specific; default 1440x900',
      samplesPerScenario: samples,
      productionBuild: true,
      note: 'Machine-local exploratory measurements; not a CI performance gate.',
    },
    budgets: {
      interactionP95Ms: 16.7,
      reactCommitP95Ms: 16.7,
      longTaskMs: 50,
      typicalDiffOpenMs: 500,
      largeDiffOpenMs: 1_000,
      warmReviewTreeMs: 500,
      warmReviewPatchMs: 1_000,
    },
    bundle,
    results,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`WROTE ${outPath}`);
} finally {
  server.kill('SIGTERM');
}

function scenario(name, surface, tier, options = {}) {
  return {
    name,
    surface,
    tier,
    variant: options.variant ?? 'baseline',
    timeoutMs: options.timeoutMs ?? 30_000,
    viewport: options.viewport ?? { width: 1440, height: 900 },
  };
}

async function measureScenario(browser, definition, sampleIndex) {
  const context = await browser.newContext({
    viewport: definition.viewport,
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  const url = new URL('/perf.html', baseUrl);
  url.searchParams.set('surface', definition.surface);
  url.searchParams.set('tier', definition.tier);
  url.searchParams.set('variant', definition.variant);

  try {
    await page.goto(url.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: definition.timeoutMs,
    });
    await page.locator('[data-benchmark-surface]').waitFor({
      state: 'attached',
      timeout: definition.timeoutMs,
    });
    if (definition.surface === 'diff') {
      await page.locator('.diff-patch, .diff-tree-host').first().waitFor({
        state: 'attached',
        timeout: definition.timeoutMs,
      });
      await page.locator('[data-line-type]').first().waitFor({
        state: 'attached',
        timeout: definition.timeoutMs,
      });
    }
    const settledAtMs =
      definition.surface === 'runtime'
        ? await waitForRuntimeReady(page)
        : await waitForDomQuiet(page, 200, definition.timeoutMs);
    const mountSnapshot = await collectPageMetrics(page);
    mountSnapshot.loadToQuietMs = settledAtMs;

    let interaction;
    let interactionSnapshot;
    if (definition.surface === 'chat') {
      interaction = await measureTyping(page, 'performance');
      interactionSnapshot = await collectPageMetrics(page);
    } else if (definition.surface === 'diff') {
      interaction = await measureScroll(page, definition.variant);
      interactionSnapshot = await collectPageMetrics(page);
    } else if (definition.surface === 'runtime') {
      await page.evaluate(() =>
        window.__NEONDECK_PERF__.resetInteractionMetrics(),
      );
      await page.waitForTimeout(1_200);
      interactionSnapshot = await collectPageMetrics(page);
    }

    return {
      sampleIndex,
      ...mountSnapshot,
      interaction,
      interactionMetrics: interactionSnapshot
        ? {
            commits: interactionSnapshot.commits,
            longTasks: interactionSnapshot.longTasks,
            markdownRenders: interactionSnapshot.markdownRenders,
            queryRequests: interactionSnapshot.queryRequests,
            queryAborts: interactionSnapshot.queryAborts,
          }
        : null,
    };
  } finally {
    await context.close();
  }
}

async function measureTyping(page, text) {
  const durations = await page.evaluate(async (value) => {
    const input = document.querySelector('[data-benchmark-input]');
    if (!(input instanceof HTMLTextAreaElement)) {
      throw new Error('Benchmark textarea not found.');
    }
    window.__NEONDECK_PERF__.resetInteractionMetrics();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    if (!setter) throw new Error('Textarea value setter unavailable.');
    const durations = [];
    let nextValue = '';
    for (const character of value) {
      nextValue += character;
      const start = performance.now();
      setter.call(input, nextValue);
      input.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: character }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      durations.push(performance.now() - start);
    }
    return durations;
  }, text);
  return summarizeDurations(durations);
}

async function measureScroll(page, variant) {
  const result = await page.evaluate(async (selectedVariant) => {
    const target = document.querySelector(
      selectedVariant === 'virtualized' ? '.perf-virtualizer' : '.diff-patch',
    );
    if (!(target instanceof HTMLElement)) return null;
    const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
    const durations = [];
    window.__NEONDECK_PERF__.resetInteractionMetrics();
    for (let index = 1; index <= 20; index += 1) {
      const start = performance.now();
      target.scrollTop = (maxScroll * index) / 20;
      target.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      durations.push(performance.now() - start);
    }
    return { durations, maxScroll };
  }, variant);
  if (!result) return null;
  return {
    ...summarizeDurations(result.durations),
    maxScroll: result.maxScroll,
  };
}

async function collectPageMetrics(page) {
  return page.evaluate(() => {
    const percentile = (values, ratio) => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[
        Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
      ];
    };
    const summarize = (durations) => ({
      count: durations.length,
      medianMs: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: durations.length > 0 ? Math.max(...durations) : 0,
    });
    const metrics = window.__NEONDECK_PERF__;
    const roots = [document];
    let domNodes = 0;
    let hiddenDomNodes = 0;
    let diffRows = 0;
    const reviewCopies = [];
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      const root = roots[rootIndex];
      const elements = [...root.querySelectorAll('*')];
      domNodes += elements.length;
      for (const element of elements) {
        if (element.matches('[data-line-type]')) diffRows += 1;
        if (element.matches('[data-review-copy]')) {
          reviewCopies.push({
            copy: element.getAttribute('data-review-copy'),
            display:
              element instanceof HTMLElement
                ? getComputedStyle(element).display
                : 'unknown',
            visible:
              element instanceof HTMLElement &&
              element.getClientRects().length > 0,
            nodes: 1 + element.querySelectorAll('*').length,
          });
        }
        if (
          element instanceof HTMLElement &&
          getComputedStyle(element).display === 'none'
        ) {
          hiddenDomNodes += 1 + element.querySelectorAll('*').length;
        }
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    const durations = metrics.commits.map((commit) => commit.actualDuration);
    const longTasks = metrics.longTasks;
    const memory = performance.memory;
    const resources = performance.getEntriesByType('resource');
    return {
      scenario: metrics.scenario,
      fixture: metrics.fixture,
      loadToQuietMs: performance.now() - metrics.startedAt,
      domNodes,
      hiddenDomNodes,
      diffRows,
      reviewCopies,
      usedJsHeapBytes: memory?.usedJSHeapSize ?? 0,
      totalJsHeapBytes: memory?.totalJSHeapSize ?? 0,
      resourceCount: resources.length,
      transferBytes: resources.reduce(
        (sum, entry) => sum + (entry.transferSize ?? 0),
        0,
      ),
      workerResources: resources.filter(
        (entry) => entry.initiatorType === 'worker',
      ).length,
      commits: {
        count: durations.length,
        totalMs: durations.reduce((sum, duration) => sum + duration, 0),
        ...summarize(durations),
      },
      longTasks: {
        count: longTasks.length,
        totalMs: longTasks.reduce((sum, duration) => sum + duration, 0),
        ...summarize(longTasks),
      },
      markdownRenders: metrics.markdownRenders,
      queryRequests: metrics.queryRequests,
      queryAborts: metrics.queryAborts,
    };
  });
}

async function waitForDomQuiet(page, quietMs, timeoutMs) {
  return page.evaluate(
    ({ quiet, timeout }) =>
      new Promise((resolve) => {
        const target = document.querySelector('[data-benchmark-surface]');
        if (!target) throw new Error('Benchmark surface not found.');
        const metrics = window.__NEONDECK_PERF__;
        let lastMutationAt = performance.now();
        let quietTimer;
        let timeoutTimer;
        const done = () => {
          observer.disconnect();
          clearTimeout(quietTimer);
          clearTimeout(timeoutTimer);
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve(Math.max(0, lastMutationAt - metrics.startedAt)),
            ),
          );
        };
        const schedule = () => {
          lastMutationAt = performance.now();
          clearTimeout(quietTimer);
          quietTimer = setTimeout(done, quiet);
        };
        const observer = new MutationObserver(schedule);
        observer.observe(target, {
          attributes: true,
          childList: true,
          characterData: true,
          subtree: true,
        });
        timeoutTimer = setTimeout(done, timeout);
        schedule();
      }),
    { quiet: quietMs, timeout: timeoutMs },
  );
}

async function waitForRuntimeReady(page) {
  await page
    .locator('.perf-runtime-heading')
    .first()
    .getByText('15/15 ready')
    .waitFor({ state: 'visible', timeout: 5_000 });
  return page.evaluate(
    () => performance.now() - window.__NEONDECK_PERF__.startedAt,
  );
}

function aggregateSamples(scenarioSamples) {
  return {
    loadToQuietMs: aggregateNumber(
      scenarioSamples.map((sample) => sample.loadToQuietMs),
    ),
    domNodes: aggregateNumber(scenarioSamples.map((sample) => sample.domNodes)),
    hiddenDomNodes: aggregateNumber(
      scenarioSamples.map((sample) => sample.hiddenDomNodes),
    ),
    usedJsHeapBytes: aggregateNumber(
      scenarioSamples.map((sample) => sample.usedJsHeapBytes),
    ),
    reactCommitP95Ms: aggregateNumber(
      scenarioSamples.map((sample) => sample.commits.p95Ms),
    ),
    interactionReactCommitP95Ms: aggregateNumber(
      scenarioSamples.map(
        (sample) => sample.interactionMetrics?.commits.p95Ms ?? 0,
      ),
    ),
    longTaskTotalMs: aggregateNumber(
      scenarioSamples.map((sample) => sample.longTasks.totalMs),
    ),
    markdownRenders: aggregateNumber(
      scenarioSamples.map(
        (sample) =>
          sample.interactionMetrics?.markdownRenders ?? sample.markdownRenders,
      ),
    ),
    queryRequests: aggregateNumber(
      scenarioSamples.map(
        (sample) =>
          sample.interactionMetrics?.queryRequests ?? sample.queryRequests,
      ),
    ),
    interactionP95Ms: aggregateNumber(
      scenarioSamples.map((sample) => sample.interaction?.p95Ms ?? 0),
    ),
  };
}

function aggregateNumber(values) {
  return {
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function summarizeDurations(durations) {
  return {
    count: durations.length,
    medianMs: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.length > 0 ? Math.max(...durations) : 0,
  };
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  ];
}

function measureProductionBundle() {
  const assetsDirectory = 'web/dist/assets';
  const files = readdirSync(assetsDirectory)
    .filter((file) => ['.js', '.css'].includes(extname(file)))
    .map((file) => {
      const contents = readFileSync(join(assetsDirectory, file));
      return {
        file,
        bytes: contents.byteLength,
        gzipBytes: gzipSync(contents).byteLength,
      };
    })
    .sort((left, right) => right.gzipBytes - left.gzipBytes);
  const html = readFileSync('web/dist/index.html', 'utf8');
  const entryFile = html.match(/assets\/(index-[^"']+\.js)/)?.[1] ?? null;
  const reviewChunk = files.find((file) =>
    file.file.startsWith('PrReviewPopoutPage-'),
  );
  return {
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    totalGzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
    entry: files.find((file) => file.file === entryFile) ?? null,
    focusedReviewChunk: reviewChunk ?? null,
    chunks: files,
  };
}

function startPreviewServer() {
  const child = spawn(
    'npm',
    [
      'exec',
      'vite',
      '--',
      'preview',
      '--config',
      'web/vite.perf.config.ts',
      '--host',
      '127.0.0.1',
      '--port',
      '4179',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForServer(url) {
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed.`);
  }
}

function readPositiveIntegerArg(name, fallback) {
  const value = readStringArg(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
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

function bytesToMb(value) {
  return value / 1024 / 1024;
}
