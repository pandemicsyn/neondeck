#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  createReviewPerformanceFixture,
  measureReviewPerformanceFixture,
  reviewPerformanceFixtureProfiles,
} from '../src/testing/review-performance-fixtures';

const args = process.argv.slice(2);
const samples = readPositiveIntegerArg('--samples', 5);
const outPath = readStringArg(
  '--out',
  'benchmarks/results/review-fixture-baseline.json',
);
const profiles = [];

for (const profile of reviewPerformanceFixtureProfiles) {
  const fixture = await createReviewPerformanceFixture(profile);
  try {
    const timing = await measureReviewPerformanceFixture(fixture, samples);
    profiles.push({
      ...profile,
      treeVisibleMs: summarize(timing.treeVisibleMs),
      firstPatchMs: summarize(timing.firstPatchMs),
      threadsVisibleMs: summarize(timing.threadsVisibleMs),
      withinTargets: {
        treeVisible: timing.treeVisibleMedianMs < 500,
        firstPatch: timing.firstPatchMedianMs < 1_000,
        threadsVisible: timing.threadsVisibleMedianMs < 500,
      },
    });
  } finally {
    await fixture.cleanup();
  }
}

const output = {
  version: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    samples,
    note: 'Machine-local deterministic Git fixture evidence; not a CI performance gate. Thread samples are in-process signals; real endpoint evidence remains in the registered-PR benchmark.',
  },
  budgets: {
    warmTreeVisibleMs: 500,
    warmFirstPatchMs: 1_000,
    warmThreadsVisibleMs: 500,
  },
  profiles,
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
    min: round(sorted[0] ?? 0),
    max: round(sorted.at(-1) ?? 0),
    samples: values.map(round),
  };
}

function round(value: number) {
  return Number(value.toFixed(1));
}

function readStringArg(name: string, fallback: string) {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

function readPositiveIntegerArg(name: string, fallback: number) {
  const value = Number(readStringArg(name, String(fallback)));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
