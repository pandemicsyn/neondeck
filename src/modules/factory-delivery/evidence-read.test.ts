import * as v from 'valibot';
import {
  candidateCheckLogSchema,
  candidateVerificationSchema,
} from './verification-contract';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import { openDb } from '../../lib/sqlite';
import { reserveCodingRun, artifactHash } from '../coding-runs';
import { codingDigest } from '../factory';
import { emptyFactorySpec } from '../../../shared/factory';
import type {
  DeliveryPipeline,
  DeliveryCommand,
  DeliveryEvidence,
} from '../../../shared/factory-delivery';
import {
  reserveDeliveryPipeline,
  updateDeliveryPipeline,
  deliveryValidationContractDigest,
} from './store';
import { deliveryReceipt } from './service-records';
import { readDeliveryEvidence } from './evidence-read';
let paths: RuntimePaths;
let p: DeliveryPipeline;
let logRef: string;
const environment = {
  policy: 'private-check-env-v1' as const,
  fingerprint: 'f'.repeat(64),
  nodeVersion: 'v26.4.0',
  platform: 'darwin',
  architecture: 'arm64',
  executableName: 'npm',
};
const summary = 'Actual reviewer finding: check the failed boundary.';
function update(action: DeliveryCommand['action']) {
  p = updateDeliveryPipeline(
    { pipelineId: p.pipelineId, expectedVersion: p.version, action },
    paths,
  );
  return p;
}
beforeEach(() => {
  paths = runtimePaths(
    realpathSync(mkdtempSync(join(tmpdir(), 'delivery-evidence-'))),
  );
  mkdirSync(dirname(paths.neondeckDatabase), { recursive: true });
  initializeAppDatabase(paths.neondeckDatabase);
  const spec = {
    ...emptyFactorySpec(),
    acceptanceCriteria: [
      {
        id: 'case-1',
        text: 'The response preserves the requested identifier.',
      },
    ],
  };
  const run = reserveCodingRun(
    {
      requestId: 'request',
      workItemId: 'work',
      releaseId: 'release',
      specVersion: 1,
      specHash: codingDigest(spec),
      specSnapshot: JSON.stringify(spec),
      sourceId: 'source',
      sourceSnapshot: '{}',
      repoId: 'repo',
      repoSnapshot: '{}',
      policySnapshot: '{}',
      contextSnapshot: '{}',
      baseSha: 'a'.repeat(40),
      harness: { provider: 'test', version: '1', model: 'test' },
      sessionMode: 'fresh',
    },
    paths,
  );
  const revision = {
    runId: run.runId,
    attemptId: run.attemptId,
    releaseId: 'release',
    specVersion: 1,
    specHash: codingDigest(spec),
    candidateDigest: 'b'.repeat(64),
    baseSha: 'a'.repeat(40),
    headSha: 'c'.repeat(40),
    treeSha: 'd'.repeat(40),
  };
  p = reserveDeliveryPipeline(
    {
      workItemId: 'work',
      repoId: 'repo',
      initialRevision: revision,
      authorization: {
        id: 'grant',
        authorizedBy: 'operator',
        authorizedAt: '2026-09-06T00:00:00.000Z',
        revision,
        repoId: 'repo',
        target: { owner: 'test', name: 'repo', baseBranch: 'main' },
        configFingerprint: 'e'.repeat(64),
        checkCommands: ['npm test'],
        maxRepairAttempts: 2,
        totalExecutionMs: 10800000,
        initialExecutionMs: 1,
      },
    },
    paths,
  );
  logRef = join(
    paths.home,
    'coding-attempts',
    run.attemptId,
    'verification-test',
    'output.json',
  );
  mkdirSync(dirname(logRef), { recursive: true });
});
afterEach(() => rmSync(paths.home, { recursive: true, force: true }));
function retain(
  kind: 'verification' | 'review',
  details: unknown,
  result: DeliveryEvidence['result'] = 'passed',
  settle = true,
) {
  const id = `${kind}-${p.version}`;
  const verification = p.evidence.findLast((e) => e.kind === 'verification');
  const producerId =
    kind === 'verification' ? 'checker' : 'reviewer-submission';
  const envelope = { producerId, result, durationMs: 5, details };
  const ref = deliveryReceipt(p.pipelineId, envelope, paths);
  update({ type: 'plan-effect', id, kind, maxExecutionMs: 1000 });
  update({ type: 'start-effect', id });
  update({
    type: 'record-evidence',
    evidence: {
      id,
      kind,
      revision: p.revision,
      producerId,
      result,
      evidenceRef: ref,
      effectId: id,
      validationContractDigest: deliveryValidationContractDigest(p),
      bundleDigest: codingDigest(details),
      verificationEvidenceId: kind === 'review' ? verification!.id : null,
      verificationBundleDigest:
        kind === 'review' ? verification!.bundleDigest : null,
    },
  });
  if (settle)
    update({
      type: 'settle-effect',
      id,
      state: 'delivered',
      receiptRef: ref,
      executionMs: 5,
    });
  return p.evidence.at(-1)!;
}
function verification(settle = true, output = 'All expected checks passed.') {
  const log = {
    command: 'npm test',
    evidenceDigest: p.revision.candidateDigest,
    treeSha: p.revision.treeSha,
    exitCode: 0,
    stdout: output,
    environment,
    mutation: null,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 5,
  };
  writeFileSync(logRef, JSON.stringify(log));
  const report = {
    evidenceDigest: p.revision.candidateDigest,
    revision: p.revision.treeSha,
    passed: true,
    noWriter: true,
    durationMs: 5,
    checks: [
      {
        command: 'npm test',
        passed: true,
        exitCode: 0,
        truncated: false,
        durationMs: 5,
        evidenceRef: logRef,
        outputHash: artifactHash(JSON.stringify(log)),
        environment,
      },
    ],
  };
  return retain('verification', report, 'passed', settle);
}
function review() {
  return retain(
    'review',
    {
      evidenceDigest: p.revision.candidateDigest,
      revision: p.revision.treeSha,
      outcome: 'findings',
      summary,
      findings: [
        {
          severity: 'high',
          path: 'src/api.ts',
          line: 12,
          description:
            'The requested identifier is dropped on the failure branch.',
        },
      ],
      submissionId: 'reviewer-submission',
      totalTokens: 50,
      durationMs: 5,
    },
    'failed',
  );
}
async function read(e: DeliveryEvidence) {
  const content = await readDeliveryEvidence(
    { deliveryId: p.pipelineId, evidenceId: e.id },
    paths,
  );
  return content;
}
function rewriteRecord(change: (r: DeliveryPipeline) => void) {
  change(p);
  const db = openDb(paths.neondeckDatabase);
  db.prepare(
    'UPDATE factory_delivery_pipelines SET record_json=? WHERE pipeline_id=?',
  ).run(JSON.stringify(p), p.pipelineId);
  db.close();
}
describe('bound public delivery evidence content', () => {
  it('shows actual check results and released criteria as inputs, redacting secrets and local paths', async () => {
    const e = verification(
      true,
      `passed\nghp_syntheticSecret TOKEN_IGNORED\nsecret=do-not-show\nBearer hidden-token\n${paths.home}/log\n/Users/synthetic/private/file\n${'z'.repeat(6000)}`,
    );
    const result = await read(e);
    expect(result.checks[0]).toMatchObject({
      command: 'npm test',
      passed: true,
      exitCode: 0,
      durationMs: 5,
      truncated: true,
    });
    expect(result.checks[0]!.output.length).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(result)).not.toContain('do-not-show');
    expect(JSON.stringify(result)).not.toContain('hidden-token');
    expect(JSON.stringify(result)).not.toContain('ghp_syntheticSecret');
    expect(JSON.stringify(result)).not.toContain(paths.home);
    expect(JSON.stringify(result)).not.toContain('/Users/');
    expect(result.acceptanceCriteria).toEqual([
      {
        id: 'case-1',
        text: 'The response preserves the requested identifier.',
      },
    ]);
    expect(result.acceptanceCriteriaRole).toBe('review-inputs');
    expect(result.effect).toMatchObject({
      settled: true,
      accounted: true,
      eligible: true,
    });
    expect(result).not.toHaveProperty('evidenceRef');
  });
  it('shows actual reviewer findings and distinguishes pending exact evidence', async () => {
    const pending = verification(false);
    expect((await read(pending)).effect).toMatchObject({
      state: 'in-flight',
      settled: false,
      accounted: false,
      eligible: false,
      eligibilityReason: 'pending',
    });
    update({
      type: 'settle-effect',
      id: pending.effectId,
      state: 'delivered',
      receiptRef: pending.evidenceRef,
      executionMs: 5,
    });
    const result = await read(review());
    expect(result.summary).toBe(summary);
    expect(result.findings).toEqual([
      {
        severity: 'high',
        path: 'src/api.ts',
        line: 12,
        description:
          'The requested identifier is dropped on the failure branch.',
      },
    ]);
    expect(result.checks).toEqual([]);
    expect(result.effect.eligibilityReason).toBe('not-passed');
  });
  it('rejects unknown evidence or arbitrary path input rather than returning an empty report', async () => {
    await expect(
      readDeliveryEvidence(
        { deliveryId: p.pipelineId, evidenceId: '/etc/passwd' },
        paths,
      ),
    ).rejects.toThrow('does not belong');
    await expect(
      readDeliveryEvidence(
        { deliveryId: p.pipelineId, evidenceId: 'missing', path: logRef },
        paths,
      ),
    ).rejects.toThrow(/key/i);
    await expect(
      readDeliveryEvidence(
        { deliveryId: 'unknown', evidenceId: 'missing' },
        paths,
      ),
    ).rejects.toThrow('Delivery not found');
  });
  it.each(['receipt-drift', 'log-drift', 'oversized-log', 'symlink-log'])(
    'fails closed for %s',
    async (kind) => {
      const e = verification();
      if (kind === 'receipt-drift')
        writeFileSync(e.evidenceRef, readFileSync(e.evidenceRef, 'utf8') + ' ');
      if (kind === 'log-drift') writeFileSync(logRef, '{"changed":true}');
      if (kind === 'oversized-log') writeFileSync(logRef, 'x'.repeat(1048577));
      if (kind === 'symlink-log') {
        const other = join(paths.home, 'elsewhere.json');
        writeFileSync(other, readFileSync(logRef));
        rmSync(logRef);
        symlinkSync(other, logRef);
      }
      await expect(read(e)).rejects.toThrow('failed integrity validation');
    },
  );
  it('rejects a malformed but content-addressed receipt', async () => {
    const e = verification();
    const body = '{broken';
    const ref = join(dirname(e.evidenceRef), `${artifactHash(body)}.json`);
    writeFileSync(ref, body);
    rewriteRecord((r) => {
      r.evidence[0]!.evidenceRef = ref;
      r.effects[0]!.receiptRef = ref;
    });
    await expect(read(e)).rejects.toThrow('failed integrity validation');
  });
  it('rejects bundle digest drift and valid-shaped wrong-revision output', async () => {
    const e = verification();
    const wrapper = JSON.parse(readFileSync(e.evidenceRef, 'utf8'));
    wrapper.details.revision = '9'.repeat(40);
    const ref = deliveryReceipt(p.pipelineId, wrapper, paths);
    rewriteRecord((r) => {
      r.evidence[0]!.evidenceRef = ref;
      r.effects[0]!.receiptRef = ref;
    });
    await expect(read(e)).rejects.toThrow('failed integrity validation');
    rewriteRecord((r) => {
      r.evidence[0]!.bundleDigest = codingDigest(wrapper.details);
    });
    await expect(read(e)).rejects.toThrow('failed integrity validation');
  });
  it('returns retained prior revision evidence as historical rather than current certification', async () => {
    const e = verification();
    const next = {
      ...p.revision,
      runId: 'repair',
      attemptId: 'repair-attempt',
      candidateDigest: 'f'.repeat(64),
    };
    rewriteRecord((r) => {
      r.repairs.push({
        runId: 'repair',
        attemptId: 'repair-attempt',
        requestId: 'repair-request',
        progressAssessmentId: null,
        progressInputDigest: null,
        progressEvidenceDigest: null,
        reservedExecutionMs: 1000,
        executionMs: 5,
        fromRevision: r.revision,
        status: 'candidate',
        revision: next,
        reason: 'scoped repair',
      });
      r.revision = next;
    });
    const result = await read(e);
    expect(result.isCurrent).toBe(false);
    expect(result.revision).toEqual(e.revision);
    expect(result.currentRevision).toEqual(next);
    expect(result.effect.eligibilityReason).toBe('prior-revision');
    expect(result.summary).toContain('1 of 1');
  });
});

it('accepts canonical environment metadata without rendering it or private references', async () => {
  const evidence = verification();
  const result = await readDeliveryEvidence(
    { deliveryId: p.pipelineId, evidenceId: evidence.id },
    paths,
  );
  expect(result.checks[0]?.output).toContain('All expected checks passed.');
  expect(JSON.stringify(result)).not.toContain('private-check-env-v1');
  expect(JSON.stringify(result)).not.toContain(logRef);
});
it('rejects a content-addressed check log with environment drift', async () => {
  const evidence = verification();
  const log = v.parse(
    candidateCheckLogSchema,
    JSON.parse(readFileSync(logRef, 'utf8')),
  );
  log.environment!.fingerprint = '0'.repeat(64);
  writeFileSync(logRef, JSON.stringify(log));
  const envelope = v.parse(
    v.object({ details: candidateVerificationSchema }),
    JSON.parse(readFileSync(evidence.evidenceRef, 'utf8')),
  );
  envelope.details.checks[0]!.outputHash = artifactHash(JSON.stringify(log));
  const changed = retain('verification', envelope.details);
  await expect(
    readDeliveryEvidence(
      { deliveryId: p.pipelineId, evidenceId: changed.id },
      paths,
    ),
  ).rejects.toThrow('integrity validation');
});

function feedbackEvidence(
  options: { classify?: boolean; settle?: boolean; body?: string } = {},
) {
  verification();
  retain('review', {
    evidenceDigest: p.revision.candidateDigest,
    revision: p.revision.treeSha,
    outcome: 'pass',
    summary: 'Checked existing scope.',
    findings: [],
    submissionId: 'reviewer-submission',
    totalTokens: 20,
    durationMs: 5,
  });
  update({ type: 'plan-effect', id: 'commit', kind: 'commit' });
  update({ type: 'start-effect', id: 'commit' });
  update({
    type: 'bind-commit',
    publishedHeadSha: p.revision.headSha,
    treeSha: p.revision.treeSha,
    evidenceRef: 'commit',
  });
  update({
    type: 'settle-effect',
    id: 'commit',
    state: 'delivered',
    receiptRef: 'commit',
  });
  const normalized = {
    headSha: p.revision.headSha,
    checks: [],
    statuses: [],
    reviews: [],
    inlineComments: [],
    issueComments: [
      {
        id: 1,
        body:
          options.body ??
          'Please add a new export scope. ghp_syntheticSecret /Users/synthetic/private password=hidden',
        user: { id: 1, login: 'external' },
        created_at: '2026-09-06T00:00:00.000Z',
        updated_at: '2026-09-06T00:00:00.000Z',
      },
    ],
  };
  const fingerprint = codingDigest(normalized);
  const observation = {
    ...normalized,
    ciFailed: false,
    hasReviewFeedback: true,
    fingerprint,
    feedbackBody: JSON.stringify({
      reviews: normalized.reviews,
      inlineComments: normalized.inlineComments,
      issueComments: normalized.issueComments,
    }),
  };
  update({
    type: 'record-feedback',
    feedback: {
      id: 'feedback-observation',
      fingerprint,
      revision: p.revision,
      publishedHeadSha: p.revision.headSha,
      ciFailed: false,
      hasReviewFeedback: true,
      evidenceRef: deliveryReceipt(p.pipelineId, observation, paths),
    },
  });
  if (options.settle === false) return p.feedback[0]!;
  const effectId = `feedback-review:${fingerprint}`;
  update({
    type: 'plan-effect',
    id: effectId,
    kind: 'feedback-review',
    maxExecutionMs: 1000,
  });
  update({ type: 'start-effect', id: effectId });
  const report = {
    evidenceDigest: p.revision.candidateDigest,
    revision: p.revision.treeSha,
    feedbackFingerprint: fingerprint,
    outcome: 'scope-change',
    summary: `The request expands export scope beyond this grant. ${paths.home}/private Bearer hidden-token`,
    findings: [
      {
        severity: 'high',
        path: '/Users/synthetic/private/file',
        line: 3,
        description:
          'Requested new export behavior needs a new released scope. secret=hidden',
      },
    ],
    submissionId: 'feedback-submission',
    totalTokens: 30,
    durationMs: 5,
  };
  const ref = deliveryReceipt(p.pipelineId, report, paths);
  update({
    type: 'settle-effect',
    id: effectId,
    state: 'delivered',
    receiptRef: ref,
    executionMs: 5,
  });
  if (options.classify !== false)
    update({
      type: 'classify-feedback',
      id: 'feedback-observation',
      effectId,
      result: 'scope-change',
      evidenceRef: ref,
    });
  return p.feedback[0]!;
}
const readFeedback = async (id = 'feedback-observation') => {
  const content = await readDeliveryEvidence(
    { deliveryId: p.pipelineId, evidenceId: id },
    paths,
  );
  return content;
};
describe('external feedback content reads', () => {
  it('reads the actual scope-change packet and findings while paused, sanitized and never certification', async () => {
    const f = feedbackEvidence();
    expect(p.interventions.at(-1)?.kind).toBe('scope');
    const result = await readFeedback();
    expect(result.kind).toBe('feedback');
    if (result.kind !== 'feedback')
      throw new Error('Expected feedback variant');
    expect(result.summary).toContain('expands export scope');
    expect(result.feedback.packet).toContain('Please add a new export scope');
    expect(result.feedback.classification).toEqual({
      result: 'scope-change',
      bound: true,
    });
    expect(result.effect).toMatchObject({
      state: 'delivered',
      settled: true,
      accounted: true,
      eligible: false,
      eligibilityReason: 'external-observation',
    });
    expect(result.findings[0]).toMatchObject({ path: null, line: 3 });
    expect(result.findings[0]?.description).toContain('new released scope');
    expect(result.revision).toEqual(f.revision);
    const publicText = JSON.stringify(result);
    for (const privateText of [
      'ghp_syntheticSecret',
      'hidden-token',
      'password=hidden',
      'secret=hidden',
      '/Users/synthetic',
      paths.home,
      f.evidenceRef,
      f.classification!.evidenceRef,
    ])
      expect(publicText).not.toContain(privateText);
  });
  it('exposes unclassified observations without inventing a reviewer or certification', async () => {
    feedbackEvidence({ settle: false });
    const result = await readFeedback();
    expect(result).toMatchObject({
      kind: 'feedback',
      result: 'observed',
      findings: [],
      effect: {
        state: 'unplanned',
        settled: false,
        accounted: false,
        eligible: false,
      },
      feedback: { classification: null },
    });
  });
  it('distinguishes a delivered classifier report awaiting durable classification binding', async () => {
    feedbackEvidence({ classify: false });
    const result = await readFeedback();
    expect(result).toMatchObject({
      kind: 'feedback',
      result: 'scope-change',
      feedback: { classification: { result: 'scope-change', bound: false } },
    });
    expect(p.feedback[0]?.classification).toBeNull();
  });
  it('bounds the exact retained packet without dropping its classifier findings', async () => {
    feedbackEvidence({ body: 'x'.repeat(14500) });
    const result = await readFeedback();
    if (result.kind !== 'feedback')
      throw new Error('Expected feedback variant');
    expect(result.feedback.packet).toHaveLength(12000);
    expect(result.feedback.packetTruncated).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.findings).toHaveLength(1);
  });
  it('preserves old revision metadata for a retained external observation', async () => {
    const f = feedbackEvidence({ settle: false });
    const next = {
      ...p.revision,
      runId: 'repair',
      attemptId: 'repair-attempt',
      candidateDigest: 'f'.repeat(64),
    };
    rewriteRecord((r) => {
      r.repairs.push({
        runId: 'repair',
        attemptId: 'repair-attempt',
        requestId: 'repair-request',
        progressAssessmentId: null,
        progressInputDigest: null,
        progressEvidenceDigest: null,
        reservedExecutionMs: 1000,
        executionMs: 5,
        fromRevision: r.revision,
        status: 'candidate',
        revision: next,
        reason: 'scoped repair',
      });
      r.revision = next;
    });
    const result = await readFeedback();
    expect(result.isCurrent).toBe(false);
    expect(result.revision).toEqual(f.revision);
    expect(result.currentRevision).toEqual(next);
  });
  it('rejects wrong observation IDs and packet digest drift instead of replacing a good old view', async () => {
    const f = feedbackEvidence();
    await expect(readFeedback('not-this-feedback')).rejects.toThrow(
      'does not belong',
    );
    writeFileSync(f.evidenceRef, '{}');
    await expect(readFeedback()).rejects.toThrow('Keep the previous view');
  });
  it.each([
    'feedbackFingerprint',
    'evidenceDigest',
    'revision',
    'durationMs',
    'outcome',
  ] as const)(
    'rejects content-addressed classifier %s binding drift',
    async (key) => {
      const f = feedbackEvidence();
      const report = v.parse(
        v.record(v.string(), v.unknown()),
        JSON.parse(readFileSync(f.classification!.evidenceRef, 'utf8')),
      );
      report[key] =
        key === 'durationMs'
          ? 6
          : key === 'outcome'
            ? 'no-action'
            : key === 'revision'
              ? '9'.repeat(40)
              : '9'.repeat(64);
      const ref = deliveryReceipt(p.pipelineId, report, paths);
      rewriteRecord((r) => {
        r.feedback[0]!.classification!.evidenceRef = ref;
        r.effects.find((e) => e.id === f.classification!.effectId)!.receiptRef =
          ref;
      });
      await expect(readFeedback()).rejects.toThrow('integrity validation');
    },
  );
  it('rejects a content-addressed packet inconsistent with its retained normalized fingerprint', async () => {
    const f = feedbackEvidence({ settle: false });
    const observation = v.parse(
      v.record(v.string(), v.unknown()),
      JSON.parse(readFileSync(f.evidenceRef, 'utf8')),
    );
    observation.feedbackBody = 'Different external instructions';
    const ref = deliveryReceipt(p.pipelineId, observation, paths);
    rewriteRecord((r) => {
      r.feedback[0]!.evidenceRef = ref;
    });
    await expect(readFeedback()).rejects.toThrow('integrity validation');
  });
  it('rejects oversized retained feedback files before parsing', async () => {
    const f = feedbackEvidence({ settle: false });
    writeFileSync(f.evidenceRef, 'x'.repeat(1048577));
    await expect(readFeedback()).rejects.toThrow('integrity validation');
  });
});

it('sanitizes decoded feedback strings before escaped JSON can hide paths or quoted credentials', async () => {
  feedbackEvidence({
    body: String.raw`Please inspect C:\Users\synthetic\private.txt and password="quoted secret".`,
  });
  const result = await readFeedback();
  expect(JSON.stringify(result)).not.toContain('synthetic');
  expect(JSON.stringify(result)).not.toContain('quoted secret');
});
