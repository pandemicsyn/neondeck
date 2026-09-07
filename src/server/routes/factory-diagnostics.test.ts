import { deliveryValidationContractDigest } from '../../modules/factory-delivery/store';
import {
  appendDiagnostic,
  saveWorker,
} from '../../modules/factory-observability/store';
import { listFactoryDiagnostics } from '../../modules/factory-observability';
import type { FactoryDiagnostic } from '../../../shared/factory-observability';
import { releaseSchema, factoryPolicy } from '../../../shared/factory';
import { codingRunRecordSchema } from '../../../shared/coding-runs';
import { writebackEffectSchema } from '../../../shared/factory-writeback';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { reserveCodingRun } from '../../modules/coding-runs/store';
import { deliveryPipelineSchema } from '../../../shared/factory-delivery';
import {
  readTaskHealthRecords,
  sourceLimit,
} from '../../modules/factory-diagnostics/records';
import { diagnoseHealth } from '../../modules/factory-diagnostics/health';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { openDb } from '../../lib/sqlite';
import {
  taskFixture,
  recordedAt,
  workerFixture,
} from '../../modules/factory-diagnostics/fixture.test-helper';
import { createFactoryDiagnosticsRoutes } from './factory-diagnostics';
import { requireLocalApiAccess } from '../middleware';
let paths: RuntimePaths;
let app: Hono;
beforeEach(() => {
  paths = runtimePaths(mkdtempSync(join(tmpdir(), 'diagnostic-routes-')));
  mkdirSync(dirname(paths.neondeckDatabase), { recursive: true });
  initializeAppDatabase(paths.neondeckDatabase);
  const records = taskFixture(),
    db = openDb(paths.neondeckDatabase);
  try {
    db.prepare(
      'INSERT INTO factory_sources(id,request_key,record) VALUES(?,?,?)',
    ).run(records.work.sourceId, 'source-request', '{}');
    db.prepare(
      'INSERT INTO factory_work_items(id,source_id,record) VALUES(?,?,?)',
    ).run(records.work.id, records.work.sourceId, JSON.stringify(records.work));
    db.prepare(
      'INSERT INTO factory_spec_revisions(work_id,version,record) VALUES(?,?,?)',
    ).run(records.work.id, 1, JSON.stringify(records.revisions[0]));
    db.prepare(
      'INSERT INTO factory_audit(work_id,action,actor,created_at) VALUES(?,?,?,?)',
    ).run(records.work.id, 'manual-intake', 'actor', recordedAt);
  } finally {
    db.close();
  }
  app = new Hono();
  app.use('/api/*', requireLocalApiAccess());
  app.route('/api/factory/diagnostics', createFactoryDiagnosticsRoutes(paths));
});
afterEach(() => rmSync(paths.home, { recursive: true, force: true }));
const request = (path: string, host = 'localhost') =>
  app.request(`http://localhost/api/factory/diagnostics${path}`, {
    headers: { host },
  });
it('serves a bounded private read and a task-scoped safe export without any source mutation', async () => {
  const timeline = await request('/tasks/work-test/timeline?limit=2');
  expect(timeline.status).toBe(200);
  expect(timeline.headers.get('cache-control')).toBe('no-store');
  const page = await timeline.json();
  expect(page.entries).toHaveLength(2);
  expect(page.nextCursor).toBeTypeOf('string');
  expect((await request('/health')).status).toBe(200);
  const snapshot = await request('/tasks/work-test/preview');
  expect(snapshot.status).toBe(200);
  const text = await snapshot.text();
  expect(text).toContain('"schemaVersion":1');
  expect(text).not.toContain('private-actor');
  expect(text).not.toContain('Private task title');
  const db = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    expect(db.prepare('SELECT count(*) AS n FROM factory_audit').get()?.n).toBe(
      1,
    );
  } finally {
    db.close();
  }
  expect((await request('/health', 'example.invalid')).status).toBe(404);
});
it('rejects missing tasks, invalid pagination and changed snapshots', async () => {
  expect((await request('/tasks/missing/timeline')).status).toBe(404);
  expect((await request('/tasks/work-test/timeline?limit=0')).status).toBe(400);
  expect((await request('/tasks/work-test/timeline?cursor=bad')).status).toBe(
    400,
  );
  const page = await (
    await request('/tasks/work-test/timeline?limit=1')
  ).json();
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare(
      'INSERT INTO factory_audit(work_id,action,actor,created_at) VALUES(?,?,?,?)',
    ).run('work-test', 'spec-saved', 'actor', recordedAt);
  } finally {
    db.close();
  }
  expect(
    (
      await request(
        `/tasks/work-test/timeline?cursor=${encodeURIComponent(page.nextCursor)}`,
      )
    ).status,
  ).toBe(409);
});
it('health excludes corrupt historical specs; timeline reports unavailable retained data', async () => {
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare('UPDATE factory_spec_revisions SET record=?').run('not json');
  } finally {
    db.close();
  }
  expect((await request('/health')).status).toBe(200);
  expect((await request('/tasks/work-test/timeline')).status).toBe(503);
});
it('reports source retention bounds honestly', async () => {
  const db = openDb(paths.neondeckDatabase);
  try {
    const insert = db.prepare(
      'INSERT INTO factory_audit(work_id,action,actor,created_at) VALUES(?,?,?,?)',
    );
    for (let i = 0; i < 205; i++)
      insert.run('work-test', 'spec-saved', 'actor', recordedAt);
  } finally {
    db.close();
  }
  const page = await (
    await request('/tasks/work-test/timeline?limit=100')
  ).json();
  expect(page.coverage.truncated).toBe(true);
  expect(page.entries.length).toBe(100);
});
it('joins planning submissions and validated legacy receipts without fabricating times', async () => {
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare(
      'INSERT INTO factory_planning_intents(id,work_id,request_key,record) VALUES(?,?,?,?)',
    ).run(
      'intent',
      'work-test',
      'plan-request',
      JSON.stringify({
        id: 'intent',
        workId: 'work-test',
        createdAt: recordedAt,
        stage: 'completed',
        submissionId: 'submission',
        triageSubmissionId: null,
      }),
    );
    db.prepare(
      'INSERT INTO factory_planning_effects(id,intent_id,record) VALUES(?,?,?)',
    ).run(
      'receipt',
      'intent',
      JSON.stringify({
        inputHash: 'a'.repeat(64),
        result: { version: 2, hash: 'b'.repeat(64) },
      }),
    );
  } finally {
    db.close();
  }
  const response = await request('/tasks/work-test/timeline');
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.entries).toContainEqual(
    expect.objectContaining({
      kind: 'planning-receipt',
      occurredAt: null,
      actor: null,
      correlation: expect.objectContaining({
        effectId: 'receipt',
        specVersion: 2,
      }),
    }),
  );
});
it('exports current pending writebacks even behind 200 historical sent effects and projects retained receipts', async () => {
  const db = openDb(paths.neondeckDatabase);
  const effect = writebackFixture();
  try {
    const insert = db.prepare(
      'INSERT INTO factory_writeback_records(id,kind,work_id,record) VALUES(?,?,?,?)',
    );
    insert.run(effect.id, 'effect', effect.workId, JSON.stringify(effect));
    for (let i = 0; i < 201; i++) {
      const sent = {
        ...effect,
        id: `sent-${i}`,
        state: 'sent',
        remoteId: `comment-${i}`,
        author: 'recorded-provider-actor',
      };
      insert.run(sent.id, 'effect', sent.workId, JSON.stringify(sent));
    }
  } finally {
    db.close();
  }
  const health = await (await request('/health?workId=work-test')).json();
  const preview = await (await request('/tasks/work-test/preview')).json();
  expect(health.tasks[0].unresolvedEffects).toHaveLength(1);
  expect(preview.health.tasks[0].unresolvedEffectCount).toBe(1);
  expect(preview.health).toHaveProperty('truncated', true);
  expect(preview.health.tasks[0]).toHaveProperty('truncated', true);
  expect(preview.timeline.truncated).toBe(true);
  const currentDb = openDb(paths.neondeckDatabase);
  try {
    currentDb
      .prepare(
        "DELETE FROM factory_writeback_records WHERE id NOT IN ('old-pending','sent-200')",
      )
      .run();
  } finally {
    currentDb.close();
  }
  const timeline = await (
    await request('/tasks/work-test/timeline?limit=100')
  ).json();
  expect(timeline.entries).toContainEqual(
    expect.objectContaining({
      id: 'writeback-state:old-pending',
      occurredAt: null,
      actor: null,
      correlation: expect.objectContaining({ effectId: 'old-pending' }),
    }),
  );
  expect(timeline.entries).toContainEqual(
    expect.objectContaining({
      id: 'writeback-state:sent-200',
      occurredAt: null,
      actor: { kind: 'unknown', id: 'recorded-provider-actor' },
      evidenceRefs: ['github-comment:comment-200'],
    }),
  );
  expect(timeline.entries).toContainEqual(
    expect.objectContaining({
      id: 'writeback-reserved:old-pending',
      occurredAt: recordedAt,
      actor: null,
    }),
  );
});

function writebackFixture() {
  return {
    id: 'old-pending',
    workId: 'work-test',
    connectionId: 'connection',
    issueId: 'issue',
    number: 1,
    connectionFingerprint: 'f',
    epoch: 'e',
    kind: 'status',
    body: 'private body',
    bodyHash: 'h',
    marker: 'm',
    specVersion: 1,
    sourceVersion: 1,
    workVersion: 1,
    approvalId: null,
    state: 'uncertain',
    remoteId: null,
    author: null,
    confirmedBody: null,
    confirmedUpdatedAt: null,
    error: null,
    attempts: 1,
    retryAt: 0,
    createdAt: recordedAt,
  };
}

function insertDelivery(id: string, outcome: unknown = null) {
  const delivery = deliveryFixture(id);
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare(
      'INSERT INTO factory_delivery_pipelines(pipeline_id,release_id,initial_run_id,initial_attempt_id,work_item_id,repo_id,branch,record_json) VALUES(?,?,?,?,?,?,?,?)',
    ).run(
      delivery.pipelineId,
      id,
      id,
      id,
      delivery.workItemId,
      delivery.repoId,
      delivery.branch,
      JSON.stringify({
        ...delivery,
        outcome,
        outcomeRef: outcome === null ? null : 'outcome-receipt',
      }),
    );
  } finally {
    db.close();
  }
}
function deliveryFixture(id: string) {
  const revision = {
    runId: id,
    attemptId: id,
    releaseId: id,
    specVersion: 1,
    specHash: 'a'.repeat(64),
    candidateDigest: 'b'.repeat(64),
    baseSha: 'c'.repeat(40),
    headSha: 'd'.repeat(40),
    treeSha: 'e'.repeat(40),
  };
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        'repo',
        revision.runId,
        revision.attemptId,
        revision.candidateDigest,
      ]),
    )
    .digest('hex');
  return v.parse(deliveryPipelineSchema, {
    pipelineId: key,
    version: 1,
    workItemId: 'work-test',
    repoId: 'repo',
    initialRevision: revision,
    revision,
    branch: `agent/factory-${key}`,
    prIdentity: `neondeck-factory:${key}`,
    pr: null,
    authorization: {
      id: 'grant',
      authorizedBy: 'actual-human',
      authorizedAt: recordedAt,
      revision,
      repoId: 'repo',
      target: { owner: 'example', name: 'repo', baseBranch: 'main' },
      configFingerprint: 'f'.repeat(64),
      checkCommands: ['npm test'],
      maxRepairAttempts: 2,
      totalExecutionMs: 10000,
      initialExecutionMs: 2000,
    },
    repairs: [],
    evidence: [],
    effects: [
      {
        id: 'review-effect',
        kind: 'review',
        revision,
        state: 'uncertain',
        receiptRef: null,
        reservedExecutionMs: 3000,
        executionMs: null,
      },
    ],
    interventions: [],
    commits: [],
    coordinator: {
      candidateRef: null,
      watchId: null,
      observationFingerprint: null,
      terminalObservedAt: null,
    },
    outcome: null,
    outcomeRef: null,
    createdAt: recordedAt,
    updatedAt: recordedAt,
  });
}

it.each(['uncertain', 'sent', 'cancelled'])(
  'rejects writeback task binding corruption in %s records',
  async (state) => {
    const effect = { ...writebackFixture(), state, workId: 'foreign-work' };
    const db = openDb(paths.neondeckDatabase);
    try {
      db.prepare(
        'INSERT INTO factory_writeback_records(id,kind,work_id,record) VALUES(?,?,?,?)',
      ).run(effect.id, 'effect', 'work-test', JSON.stringify(effect));
    } finally {
      db.close();
    }
    for (const path of [
      '/tasks/work-test/timeline',
      '/tasks/work-test/preview',
    ]) {
      const response = await request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'Task record binding is inconsistent.',
      });
    }
    for (const path of ['/health', '/health?workId=work-test']) {
      const response = await request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'Task record binding is inconsistent.',
      });
    }
  },
);
it.each(['invalid', 42, {}, false])(
  'fails closed on invalid delivery outcome %j',
  async (outcome) => {
    insertDelivery('corrupt', outcome);
    for (const path of [
      '/tasks/work-test/timeline',
      '/tasks/work-test/preview',
      '/health',
      '/health?workId=work-test',
    ]) {
      const response = await request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error:
          'Retained diagnostic records are unavailable or invalid. Check the local database and refresh.',
      });
    }
  },
);
it('retains both active pipelines without claiming omitted coverage', async () => {
  insertDelivery('older-active');
  for (const outcome of ['merged', 'closed', 'cancelled', 'failed'])
    insertDelivery(outcome, outcome);
  let response = await request('/health?workId=work-test');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    truncated: false,
    tasks: [
      {
        status: 'needs-reconciliation',
        truncated: false,
        budgets: [{ deliveryId: deliveryFixture('older-active').pipelineId }],
      },
    ],
  });
  insertDelivery('newer-active');
  const db = openDb(paths.neondeckDatabase);
  try {
    const newer = deliveryFixture('newer-active');
    newer.effects[0].state = 'planned';
    db.prepare(
      'UPDATE factory_delivery_pipelines SET record_json=? WHERE pipeline_id=?',
    ).run(JSON.stringify(newer), newer.pipelineId);
  } finally {
    db.close();
  }
  response = await request('/health?workId=work-test');
  expect(await response.json()).toMatchObject({
    truncated: false,
    tasks: [
      {
        truncated: false,
        status: 'needs-reconciliation',
        unresolvedEffects: [
          {
            deliveryId: deliveryFixture('newer-active').pipelineId,
            state: 'planned',
          },
          {
            deliveryId: deliveryFixture('older-active').pipelineId,
            state: 'uncertain',
          },
        ],
        budgets: [
          { deliveryId: deliveryFixture('newer-active').pipelineId },
          { deliveryId: deliveryFixture('older-active').pipelineId },
        ],
      },
    ],
  });
});
it('does not treat terminal delivery history as pending work', async () => {
  for (const outcome of ['merged', 'closed', 'cancelled', 'failed'])
    insertDelivery(outcome, outcome);
  const response = await request('/health?workId=work-test');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    truncated: false,
    tasks: [
      {
        status: 'shaping',
        budgets: [],
        unresolvedEffects: [],
        truncated: false,
      },
    ],
  });
});
it('bounds delivery candidate validation and marks omitted history as attention', async () => {
  insertDelivery('older-active');
  insertDelivery('outside-window', 'invalid');
  for (let i = 0; i <= sourceLimit; i++)
    insertDelivery(`terminal-${i}`, 'merged');
  const response = await request('/health?workId=work-test');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    truncated: true,
    tasks: [{ truncated: true, budgets: [] }],
  });
  const db = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    expect(
      diagnoseHealth(
        [readTaskHealthRecords(db, 'work-test')],
        [workerFixture()],
        recordedAt,
      ),
    ).toMatchObject({ status: 'attention', truncated: true });
  } finally {
    db.close();
  }
});
it('validates the extra delivery candidate used to detect truncation', async () => {
  insertDelivery('boundary-corrupt', 'invalid');
  for (let i = 0; i < sourceLimit; i++)
    insertDelivery(`terminal-${i}`, 'merged');
  expect((await request('/health?workId=work-test')).status).toBe(503);
});

function insertPlanning(id: string, overrides: Record<string, unknown> = {}) {
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare(
      'INSERT INTO factory_planning_intents(id,work_id,request_key,record) VALUES(?,?,?,?)',
    ).run(
      id,
      'work-test',
      id,
      JSON.stringify({
        id,
        workId: 'work-test',
        createdAt: recordedAt,
        stage: 'triage',
        submissionId: null,
        triageSubmissionId: null,
        ...overrides,
      }),
    );
  } finally {
    db.close();
  }
}
const diagnosticPaths = [
  '/tasks/work-test/timeline',
  '/tasks/work-test/preview',
  '/health',
  '/health?workId=work-test',
];
it.each([
  { id: 'foreign' },
  { workId: 'foreign' },
  { id: null },
  { workId: null },
  { id: undefined },
  { workId: undefined },
  { id: 42 },
  { workId: {} },
  { stage: 'invalid' },
  { stage: null },
  { stage: undefined },
  { stage: 42 },
  { stage: false },
  { stage: {} },
])(
  'fails closed on planning metadata corruption %j across routes',
  async (overrides) => {
    insertPlanning('intent', overrides);
    for (const path of diagnosticPaths)
      expect((await request(path)).status).toBe(503);
  },
);
it.each([undefined, null, 'invalid', 42, false, {}, []])(
  'fails closed on unclassifiable writeback state %j across routes',
  async (state) => {
    const effect = { ...writebackFixture(), state };
    const db = openDb(paths.neondeckDatabase);
    try {
      db.prepare(
        'INSERT INTO factory_writeback_records(id,kind,work_id,record) VALUES(?,?,?,?)',
      ).run(effect.id, 'effect', effect.workId, JSON.stringify(effect));
    } finally {
      db.close();
    }
    for (const path of diagnosticPaths)
      expect((await request(path)).status).toBe(503);
  },
);
it('validates legacy planning metadata before filtering terminal stages', async () => {
  insertPlanning('active');
  insertPlanning('completed', { stage: 'completed' });
  insertPlanning('failed', { stage: 'failed' });
  for (const path of diagnosticPaths)
    expect((await request(path)).status).toBe(200);
  const db = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    expect(readTaskHealthRecords(db, 'work-test')).toMatchObject({
      planning: [{ id: 'active' }],
      truncated: false,
    });
  } finally {
    db.close();
  }
  insertPlanning('newest', { stage: 'planner' });
  expect(
    await (await request('/health?workId=work-test')).json(),
  ).toMatchObject({
    truncated: true,
    tasks: [{ status: 'planning-planner', truncated: true }],
  });
});
it.each([{ stage: 'invalid' }, { id: 'foreign' }, { workId: 'foreign' }])(
  'validates the extra planning candidate %j on both routes',
  async (overrides) => {
    insertPlanning('boundary', overrides);
    for (let i = 0; i < sourceLimit; i++)
      insertPlanning(`terminal-${i}`, { stage: 'completed' });
    for (const path of diagnosticPaths)
      expect((await request(path)).status).toBe(503);
  },
);
it('bounds planning validation and reports omitted active or invalid history as attention', async () => {
  insertPlanning('older-active');
  insertPlanning('outside', { stage: 'invalid' });
  for (let i = 0; i <= sourceLimit; i++)
    insertPlanning(`terminal-${i}`, { stage: 'completed' });
  expect((await request('/tasks/work-test/timeline')).status).toBe(200);
  expect(
    await (await request('/health?workId=work-test')).json(),
  ).toMatchObject({
    truncated: true,
    tasks: [{ truncated: true }],
  });
  const db = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const records = readTaskHealthRecords(db, 'work-test');
    expect(records.planning).toEqual([]);
    expect(
      diagnoseHealth([records], [workerFixture()], recordedAt),
    ).toMatchObject({
      status: 'attention',
      truncated: true,
    });
  } finally {
    db.close();
  }
});
it.each([{ id: 'foreign' }, { workId: 'foreign' }])(
  'validates receipt parent metadata outside the intent window %j',
  async (overrides) => {
    insertPlanning('outside', overrides);
    for (let i = 0; i <= sourceLimit; i++)
      insertPlanning(`terminal-${i}`, { stage: 'completed' });
    const db = openDb(paths.neondeckDatabase);
    try {
      db.prepare(
        'INSERT INTO factory_planning_effects(id,intent_id,record) VALUES(?,?,?)',
      ).run(
        'receipt',
        'outside',
        JSON.stringify({
          inputHash: 'a'.repeat(64),
          result: { version: 2, hash: 'b'.repeat(64) },
        }),
      );
    } finally {
      db.close();
    }
    expect((await request('/tasks/work-test/timeline')).status).toBe(503);
    expect((await request('/tasks/work-test/preview')).status).toBe(503);
  },
);

it('rejects writeback row/JSON identity mismatches across routes', async () => {
  const effect = writebackFixture();
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare(
      'INSERT INTO factory_writeback_records(id,kind,work_id,record) VALUES(?,?,?,?)',
    ).run('different-row', 'effect', effect.workId, JSON.stringify(effect));
  } finally {
    db.close();
  }
  for (const path of diagnosticPaths)
    expect((await request(path)).status).toBe(503);
});
it('rejects delivery row/JSON identity mismatches across routes', async () => {
  insertDelivery('mismatched');
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare('UPDATE factory_delivery_pipelines SET pipeline_id=?').run(
      'different-row',
    );
  } finally {
    db.close();
  }
  for (const path of diagnosticPaths)
    expect((await request(path)).status).toBe(503);
});
it('rejects revision row/JSON version mismatches in retained history', async () => {
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare('UPDATE factory_spec_revisions SET version=2').run();
  } finally {
    db.close();
  }
  expect((await request('/tasks/work-test/timeline')).status).toBe(503);
  expect((await request('/tasks/work-test/preview')).status).toBe(503);
  expect((await request('/health?workId=work-test')).status).toBe(200);
});

function insertRun(id: string) {
  return reserveCodingRun(
    {
      requestId: id,
      workItemId: 'work-test',
      releaseId: id,
      specVersion: 1,
      specHash: 'a'.repeat(64),
      specSnapshot: '{}',
      sourceId: 'source-test',
      sourceSnapshot: '{}',
      repoId: 'repo',
      repoSnapshot: '{}',
      policySnapshot: '{}',
      contextSnapshot: '{}',
      baseSha: 'b'.repeat(40),
      harness: { provider: 'test', version: '1', model: 'test-model' },
      sessionMode: 'fresh',
    },
    paths,
  );
}
it('rejects coding run row/JSON identity mismatches across routes', async () => {
  const run = insertRun('run');
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare('UPDATE coding_runs SET record_json=? WHERE run_id=?').run(
      JSON.stringify({ ...run, runId: 'foreign' }),
      run.runId,
    );
  } finally {
    db.close();
  }
  for (const path of diagnosticPaths)
    expect((await request(path)).status).toBe(503);
});
it.each([
  'runId',
  'attemptId',
  'requestId',
  'releaseId',
  'workItemId',
  'worktreeId',
  'writer_slot',
])(
  'validates event parent %s outside the retained run window',
  async (field) => {
    const run = insertRun('outside');
    const db = openDb(paths.neondeckDatabase);
    try {
      // Insert valid independent historical rows without reserving concurrent writers.
      const insert = db.prepare(
        'INSERT INTO coding_runs(run_id,attempt_id,request_id,work_item_id,release_id,record_json) VALUES(?,?,?,?,?,?)',
      );
      for (let i = 0; i <= sourceLimit; i++) {
        const id = `new-${i}`;
        insert.run(
          id,
          id,
          id,
          'work-test',
          id,
          JSON.stringify({
            ...run,
            runId: id,
            attemptId: id,
            status: 'failed',
            completedAt: recordedAt,
            cleanupAttentionAt: recordedAt,
            evidenceRetainUntil: recordedAt,
            deadProof: {
              runId: id,
              attemptId: id,
              ownershipToken: run.ownershipToken,
              host: null,
              kind: 'never-started',
              evidenceRef: 'proof',
            },
            snapshot: { ...run.snapshot, requestId: id, releaseId: id },
          }),
        );
      }
      // Verify the complete bounded projection and the out-of-window event parent first.
      for (const path of diagnosticPaths)
        expect((await request(path)).status).toBe(200);
      if (field === 'worktreeId' || field === 'writer_slot') {
        db.exec('PRAGMA foreign_keys=OFF');
        db.prepare(
          `UPDATE coding_runs SET ${field === 'worktreeId' ? 'worktree_id' : 'writer_slot'}=? WHERE run_id=?`,
        ).run(field === 'worktreeId' ? 'foreign' : null, run.runId);
      } else {
        const corrupt = structuredClone(run);
        if (field === 'runId' || field === 'attemptId')
          corrupt[field] = 'foreign';
        else
          corrupt.snapshot[field as 'requestId' | 'releaseId' | 'workItemId'] =
            'foreign';
        db.prepare('UPDATE coding_runs SET record_json=? WHERE run_id=?').run(
          JSON.stringify(corrupt),
          run.runId,
        );
      }
    } finally {
      db.close();
    }
    expect((await request('/tasks/work-test/timeline')).status).toBe(503);
    expect((await request('/tasks/work-test/preview')).status).toBe(503);
    expect((await request('/health?workId=work-test')).status).toBe(200);
  },
);

it.each(['closed', 'paused', 'shaping'] as const)(
  'keeps external failures and active effects visible while %s',
  async (lifecycle) => {
    const db = openDb(paths.neondeckDatabase);
    try {
      const work = { ...taskFixture().work, lifecycle };
      db.prepare('UPDATE factory_work_items SET record=? WHERE id=?').run(
        JSON.stringify(work),
        work.id,
      );
      for (const [state, status, overall] of [
        ['uncertain', 'needs-reconciliation', 'attention'],
        ['repair', 'needs-reconciliation', 'attention'],
        ['failed', 'writeback-pending', 'attention'],
        ['sending', 'writeback-pending', 'healthy'],
        ['pending', 'writeback-pending', 'healthy'],
      ]) {
        const effect = { ...writebackFixture(), state };
        db.prepare(
          'INSERT OR REPLACE INTO factory_writeback_records(id,kind,work_id,record) VALUES(?,?,?,?)',
        ).run(effect.id, 'effect', work.id, JSON.stringify(effect));
        const health = diagnoseHealth(
          [readTaskHealthRecords(db, work.id)],
          [workerFixture()],
          recordedAt,
        );
        expect(health).toMatchObject({ status: overall, tasks: [{ status }] });
        const api = await (await request('/health?workId=work-test')).json();
        const preview = await (
          await request('/tasks/work-test/preview')
        ).json();
        expect(api.tasks[0].status).toBe(status);
        expect(preview.health.status).toBe(api.status);
        expect(preview.health.tasks[0].unresolvedEffectCount).toBe(
          api.tasks[0].unresolvedEffects.length,
        );
      }
    } finally {
      db.close();
    }
  },
);

it.each(['closed', 'paused', 'shaping', 'queued'] as const)(
  'binds terminal run guidance and preserves older recovery during %s',
  (lifecycle) => {
    const run = insertRun('release');
    const revision = taskFixture().revisions[0];
    revision.hash = createHash('sha256')
      .update(JSON.stringify(revision.spec))
      .digest('hex');
    revision.repoFingerprint = 'a'.repeat(64);
    run.snapshot.specHash = revision.hash;
    const failed = {
      ...run,
      status: 'failed',
      completedAt: recordedAt,
      cleanupAttentionAt: recordedAt,
      evidenceRetainUntil: recordedAt,
      deadProof: {
        runId: run.runId,
        attemptId: run.attemptId,
        ownershipToken: run.ownershipToken,
        host: null,
        kind: 'never-started',
        evidenceRef: 'proof',
      },
    };
    const db = openDb(paths.neondeckDatabase);
    try {
      db.prepare('UPDATE factory_spec_revisions SET record=?').run(
        JSON.stringify(revision),
      );
      const work = { ...taskFixture().work, lifecycle, repoId: 'repo' };
      db.prepare('UPDATE factory_work_items SET record=? WHERE id=?').run(
        JSON.stringify(work),
        work.id,
      );
      db.prepare(
        'UPDATE coding_runs SET record_json=?,writer_slot=NULL WHERE run_id=?',
      ).run(JSON.stringify(failed), run.runId);
      const release = {
        id: 'release',
        workId: work.id,
        requestKey: 'release',
        actor: 'human',
        specVersion: 1,
        specHash: revision.hash,
        sourceVersion: 1,
        repoId: 'repo',
        repoFingerprint: 'a'.repeat(64),
        policy: {
          version: 'isolated-local-v1',
          implementation: 'isolated-worktree',
          checks: 'repo-configured',
          publish: false,
          merge: false,
          deploy: false,
        },
        createdAt: recordedAt,
        withdrawnAt: null,
        withdrawalReason: null,
      };
      db.prepare(
        'INSERT INTO factory_releases(id,work_id,request_key,record) VALUES(?,?,?,?)',
      ).run(release.id, work.id, release.requestKey, JSON.stringify(release));
      const status = () =>
        diagnoseHealth(
          [readTaskHealthRecords(db, work.id)],
          [workerFixture()],
          recordedAt,
        ).tasks[0].status;
      expect(status()).toBe(
        lifecycle === 'queued' ? 'coding-failed' : lifecycle,
      );
      for (const terminalStatus of [
        'candidate',
        'failed',
        'cancelled',
      ] as const) {
        const host = { hostId: 'host', jobId: 'job' };
        const terminal =
          terminalStatus === 'candidate'
            ? {
                ...failed,
                status: terminalStatus,
                host,
                workspace: { worktreeId: 'wt', lockId: 'lock' },
                providerSessionId: 'session',
                deadProof: { ...failed.deadProof, host, kind: 'verified-dead' },
                candidate: {
                  baseSha: run.snapshot.baseSha,
                  headSha: 'c'.repeat(40),
                  worktreeId: 'wt',
                  statusRef: 'status',
                  diffRef: 'diff',
                  includesUntracked: true,
                },
              }
            : {
                ...failed,
                status: terminalStatus,
                cancelRequestedAt:
                  terminalStatus === 'cancelled' ? recordedAt : null,
                cancelReason:
                  terminalStatus === 'cancelled' ? 'cancelled' : null,
              };
        // Synthetic retained workspace; this projection does not inspect workspace ownership.
        db.exec('PRAGMA foreign_keys=OFF');
        db.prepare(
          'UPDATE coding_runs SET record_json=?,worktree_id=? WHERE run_id=?',
        ).run(
          JSON.stringify(terminal),
          terminalStatus === 'candidate' ? 'wt' : null,
          run.runId,
        );
        expect(status()).toBe(
          lifecycle === 'queued'
            ? terminalStatus === 'candidate'
              ? 'candidate'
              : `coding-${terminalStatus}`
            : lifecycle,
        );
        db.prepare('UPDATE factory_releases SET record=? WHERE id=?').run(
          JSON.stringify({ ...release, withdrawnAt: recordedAt }),
          release.id,
        );
        expect(status()).toBe(
          lifecycle === 'queued' ? 'release-blocked' : lifecycle,
        );
        db.prepare('UPDATE factory_releases SET record=? WHERE id=?').run(
          JSON.stringify(release),
          release.id,
        );
      }
      db.prepare(
        'UPDATE coding_runs SET record_json=?,writer_slot=NULL WHERE run_id=?',
      ).run(JSON.stringify(failed), run.runId);
      for (const stale of [
        { ...release, withdrawnAt: recordedAt },
        { ...release, specHash: 'b'.repeat(64) },
        { ...release, specVersion: 2 },
        { ...release, repoId: 'other' },
      ]) {
        db.prepare('UPDATE factory_releases SET record=? WHERE id=?').run(
          JSON.stringify(stale),
          release.id,
        );
        expect(status()).toBe(
          lifecycle === 'queued' ? 'release-blocked' : lifecycle,
        );
      }
      db.prepare('UPDATE factory_releases SET record=? WHERE id=?').run(
        JSON.stringify(release),
        release.id,
      );
      for (const changed of [
        { ...work, specVersion: 2 },
        { ...work, repoId: 'other' },
      ]) {
        db.prepare('UPDATE factory_work_items SET record=? WHERE id=?').run(
          JSON.stringify(changed),
          work.id,
        );
        expect(status()).toBe(
          lifecycle === 'queued' ? 'release-blocked' : lifecycle,
        );
      }
      db.prepare('UPDATE factory_work_items SET record=? WHERE id=?').run(
        JSON.stringify(work),
        work.id,
      );
      db.prepare('UPDATE factory_releases SET record=? WHERE id=?').run(
        JSON.stringify({ ...release, withdrawnAt: 42 }),
        release.id,
      );
      let invalidReleaseRejected = false;
      try {
        status();
      } catch (error) {
        invalidReleaseRejected = error instanceof v.ValiError;
      }
      expect(invalidReleaseRejected).toBe(lifecycle === 'queued');
      db.prepare('UPDATE factory_releases SET record=? WHERE id=?').run(
        JSON.stringify(release),
        release.id,
      );
      for (const activeStatus of [
        'reserved',
        'running',
        'collecting',
      ] as const) {
        db.prepare(
          "UPDATE coding_runs SET record_json=?,writer_slot=1,worktree_id='wt' WHERE run_id=?",
        ).run(
          JSON.stringify({
            ...run,
            status: activeStatus,
            host: { hostId: 'host', jobId: 'job' },
            workspace: { worktreeId: 'wt', lockId: 'lock' },
          }),
          run.runId,
        );
        expect(status()).toBe(`coding-${activeStatus}`);
      }
      db.prepare(
        'UPDATE coding_runs SET record_json=?,writer_slot=1,worktree_id=NULL WHERE run_id=?',
      ).run(JSON.stringify({ ...run, status: 'needs-reconcile' }), run.runId);
      expect(status()).toBe('needs-reconciliation');
      db.prepare(
        'UPDATE coding_runs SET record_json=?,writer_slot=1,worktree_id=NULL WHERE run_id=?',
      ).run(JSON.stringify(run), run.runId);
      expect(status()).toBe('coding-reserved');
      // A newer terminal run cannot hide an older live reservation.
      db.prepare(
        'INSERT INTO coding_runs(run_id,attempt_id,request_id,work_item_id,release_id,record_json) VALUES(?,?,?,?,?,?)',
      ).run(
        'new',
        'new',
        'new',
        work.id,
        'new',
        JSON.stringify({
          ...failed,
          runId: 'new',
          attemptId: 'new',
          snapshot: { ...run.snapshot, releaseId: 'new', requestId: 'new' },
          deadProof: { ...failed.deadProof, runId: 'new', attemptId: 'new' },
        }),
      );
      expect(status()).toBe('coding-reserved');
    } finally {
      db.close();
    }
  },
);

it.each(['closed', 'paused', 'shaping'] as const)(
  'prioritizes uncertain assessments and live delivery over %s',
  (lifecycle) => {
    const records = taskFixture();
    records.work.lifecycle = lifecycle;
    const delivery = deliveryFixture('delivery');
    records.deliveries = [delivery];
    const status = () =>
      diagnoseHealth([records], [workerFixture()], recordedAt);
    expect(status()).toMatchObject({
      status: 'attention',
      tasks: [{ status: 'needs-reconciliation' }],
    });
    delivery.effects[0].state = 'in-flight';
    expect(status().tasks[0].status).toBe('delivery-pending');
    delivery.effects = [];
    delivery.version = 2;
    delivery.progress.assessments.push({
      assessmentId: 'assessment',
      grantId: 'grant',
      revision: delivery.revision,
      repairOrdinal: 1,
      requestId: 'assessment',
      inputDigest: 'a'.repeat(64),
      evidenceDigest: 'b'.repeat(64),
      evidenceRefs: ['evidence'],
      instructions: 'Review progress',
      state: 'uncertain',
      sourceVersion: 1,
      remainingExecutionMs: 1000,
      reservedAt: recordedAt,
      deadlineAt: new Date(Date.parse(recordedAt) + 1000).toISOString(),
      reservedExecutionMs: 1000,
      executionMs: null,
      completedAt: null,
      submissionId: null,
      resultId: null,
      result: null,
    });
    expect(status()).toMatchObject({
      status: 'attention',
      tasks: [{ status: 'needs-reconciliation' }],
    });
    delivery.progress.assessments[0].state = 'reserved';
    expect(status()).toMatchObject({
      status: 'healthy',
      tasks: [{ status: 'assessment-reserved' }],
    });
    delivery.progress.assessments.push({
      ...delivery.progress.assessments[0],
      assessmentId: 'second',
      requestId: 'second',
      repairOrdinal: 2,
      state: 'uncertain',
    });
    expect(status()).toMatchObject({
      status: 'attention',
      tasks: [{ status: 'needs-reconciliation' }],
    });
    delivery.progress.assessments = [];
    delivery.repairs.push({
      runId: 'repair',
      attemptId: 'repair',
      requestId: 'repair',
      reservedExecutionMs: 1000,
      executionMs: null,
      fromRevision: delivery.revision,
      progressAssessmentId: null,
      progressInputDigest: null,
      progressEvidenceDigest: null,
      status: 'reserved',
      revision: null,
      reason: 'Repair',
    });
    expect(status().tasks[0].status).toBe('delivery-pending');
  },
);

function faultCoexistenceFixture() {
  const records = taskFixture();
  records.work.lifecycle = 'queued';
  records.work.repoId = 'repo';
  const run = insertRun('release');
  records.revisions[0].hash = createHash('sha256')
    .update(JSON.stringify(records.revisions[0].spec))
    .digest('hex');
  records.revisions[0].repoFingerprint = 'a'.repeat(64);
  run.snapshot.specHash = records.revisions[0].hash;
  records.runs = [
    v.parse(codingRunRecordSchema, {
      ...run,
      status: 'failed',
      completedAt: recordedAt,
      cleanupAttentionAt: recordedAt,
      evidenceRetainUntil: recordedAt,
      deadProof: {
        runId: run.runId,
        attemptId: run.attemptId,
        ownershipToken: run.ownershipToken,
        host: null,
        kind: 'never-started',
        evidenceRef: 'proof',
      },
    }),
  ];
  records.releases = [
    v.parse(releaseSchema, {
      id: 'release',
      workId: records.work.id,
      requestKey: 'release',
      actor: 'human',
      specVersion: 1,
      specHash: records.revisions[0].hash,
      sourceVersion: 1,
      repoId: 'repo',
      repoFingerprint: 'a'.repeat(64),
      policy: factoryPolicy,
      createdAt: recordedAt,
      withdrawnAt: null,
      withdrawalReason: null,
    }),
  ];
  return { records, run };
}
function assessmentFixture(delivery: ReturnType<typeof deliveryFixture>) {
  delivery.version = 2;
  return {
    assessmentId: 'assessment',
    grantId: 'grant',
    revision: delivery.revision,
    repairOrdinal: 1,
    requestId: 'assessment',
    inputDigest: 'a'.repeat(64),
    evidenceDigest: 'b'.repeat(64),
    evidenceRefs: ['evidence'],
    instructions: 'Review progress',
    state: 'reserved' as const,
    sourceVersion: 1,
    remainingExecutionMs: 8000,
    reservedAt: recordedAt,
    deadlineAt: new Date(Date.parse(recordedAt) + 8000).toISOString(),
    reservedExecutionMs: 8000,
    executionMs: null,
    completedAt: null,
    submissionId: null,
    resultId: null,
    result: null,
  };
}
it.each([
  'pending',
  'sending',
  'assessment',
  'coding',
  'delivery',
  'planning',
] as const)('keeps actionable faults ahead of benign %s work', (pending) => {
  const { records, run } = faultCoexistenceFixture();
  const active = deliveryFixture('active');
  active.effects = [];
  if (pending === 'pending' || pending === 'sending') {
    records.writeback.push(
      v.parse(writebackEffectSchema, { ...writebackFixture(), state: pending }),
    );
  } else if (pending === 'assessment') {
    active.progress.assessments.push(assessmentFixture(active));
    records.deliveries.push(active);
  } else if (pending === 'coding') {
    records.runs.push({
      ...run,
      snapshot: { ...run.snapshot, releaseId: 'older-release' },
    });
  } else if (pending === 'delivery') {
    active.effects = deliveryFixture('active').effects;
    active.effects[0].state = 'in-flight';
    records.deliveries.push(active);
  } else {
    records.planning.push({
      id: 'planning',
      workId: records.work.id,
      createdAt: recordedAt,
      stage: 'planner',
      submissionId: null,
      triageSubmissionId: null,
    });
  }
  const health = () => diagnoseHealth([records], [workerFixture()], recordedAt);
  expect(health()).toMatchObject({
    status: 'attention',
    tasks: [
      {
        status: 'coding-failed',
        nextStep: expect.stringContaining('resolve the failure'),
      },
    ],
  });
  // The failed run is now historical; a distinct spent pipeline still needs attention.
  records.releases[0].withdrawnAt = recordedAt;
  const exhausted = deliveryFixture('exhausted');
  exhausted.effects = [];
  exhausted.authorization.initialExecutionMs =
    exhausted.authorization.totalExecutionMs;
  records.deliveries.push(exhausted);
  expect(health()).toMatchObject({
    status: 'attention',
    tasks: [
      {
        status: 'budget-exhausted',
        nextStep: expect.stringContaining('human budget decision'),
      },
    ],
  });
  records.deliveries = records.deliveries.filter(
    (delivery) => delivery !== exhausted,
  );
  records.writeback.push(
    v.parse(writebackEffectSchema, {
      ...writebackFixture(),
      id: 'failed-writeback',
      state: 'failed',
    }),
  );
  expect(health()).toMatchObject({
    status: 'attention',
    tasks: [
      {
        status: 'writeback-pending',
        nextStep: expect.stringContaining('failed GitHub writeback'),
      },
    ],
  });
  // Reconciliation beats all faults, even when they coexist with active work.
  records.releases[0].withdrawnAt = null;
  records.deliveries.push(exhausted);
  records.writeback.push(
    v.parse(writebackEffectSchema, {
      ...writebackFixture(),
      id: 'uncertain-writeback',
      state: 'uncertain',
    }),
  );
  expect(health()).toMatchObject({
    status: 'attention',
    tasks: [{ status: 'needs-reconciliation' }],
  });
});
it.each(['assessment', 'effect', 'repair'] as const)(
  'does not call a fully reserved active %s budget exhausted',
  (kind) => {
    const records = taskFixture();
    const delivery = deliveryFixture('active');
    delivery.effects = [];
    records.deliveries.push(delivery);
    records.writeback.push(
      v.parse(writebackEffectSchema, {
        ...writebackFixture(),
        state: 'pending',
      }),
    );
    if (kind === 'assessment') {
      delivery.progress.assessments.push(assessmentFixture(delivery));
    } else if (kind === 'effect') {
      delivery.effects = deliveryFixture('active').effects;
      delivery.effects[0].state = 'in-flight';
      delivery.effects[0].reservedExecutionMs = 8000;
    } else {
      delivery.repairs.push({
        runId: 'repair',
        attemptId: 'repair',
        requestId: 'repair',
        reservedExecutionMs: 8000,
        executionMs: null,
        fromRevision: delivery.revision,
        progressAssessmentId: null,
        progressInputDigest: null,
        progressEvidenceDigest: null,
        status: 'reserved',
        revision: null,
        reason: 'Repair',
      });
    }
    expect(
      diagnoseHealth([records], [workerFixture()], recordedAt),
    ).toMatchObject({
      status: 'healthy',
      tasks: [
        {
          status:
            kind === 'assessment' ? 'assessment-reserved' : 'delivery-pending',
          budgets: [
            {
              consumedExecutionMs: 2000,
              reservedExecutionMs: 8000,
              remainingExecutionMs: 0,
            },
          ],
        },
      ],
    });
  },
);

function retainedSpan(): FactoryDiagnostic {
  const now = new Date().toISOString();
  return {
    sequence: 0,
    id: 'span-test',
    traceId: 'trace-test',
    parentSpanId: null,
    operation: 'coding.tick',
    kind: 'phase',
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    outcome: 'success',
    correlation: { workItemId: 'work-test' },
    error: null,
  };
}
const retainedError = {
  error:
    'Retained diagnostic records are unavailable or invalid. Check the local database and refresh.',
};
it.each(['foreign', 'missing', 'finishedAt'])(
  'fails preview closed for a retained span with %s binding corruption',
  async (corruption) => {
    const span = retainedSpan();
    appendDiagnostic(paths, span);
    const corrupt = {
      ...span,
      correlation:
        corruption === 'foreign'
          ? { workItemId: 'foreign-task' }
          : corruption === 'missing'
            ? {}
            : span.correlation,
      finishedAt:
        corruption === 'finishedAt'
          ? '2000-01-01T00:00:00.000Z'
          : span.finishedAt,
    };
    const db = openDb(paths.neondeckDatabase);
    try {
      db.prepare('UPDATE factory_diagnostics SET record_json=?').run(
        JSON.stringify(corrupt),
      );
    } finally {
      db.close();
    }
    const response = await request('/tasks/work-test/preview');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(retainedError);
    expect(() => listFactoryDiagnostics(paths)).toThrow(v.ValiError);
  },
);
it.each([null, 'foreign-task'])(
  'fails preview closed when task JSON has reverse index binding %s',
  async (indexedTask) => {
    appendDiagnostic(paths, {
      ...retainedSpan(),
      outcome: 'failure',
      error: { class: 'io', code: 'ENOENT' },
    });
    const db = openDb(paths.neondeckDatabase);
    try {
      db.prepare('UPDATE factory_diagnostics SET work_item_id=?').run(
        indexedTask,
      );
    } finally {
      db.close();
    }
    // A newer healthy span must not hide a corrupt lookahead candidate.
    appendDiagnostic(paths, { ...retainedSpan(), id: 'newer' });
    expect(() =>
      listFactoryDiagnostics(paths, { workItemId: 'work-test', limit: 1 }),
    ).toThrow(v.ValiError);
    const response = await request('/tasks/work-test/preview');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(retainedError);
  },
);
it('rejects an expired date index with current task JSON instead of omitting the span', async () => {
  appendDiagnostic(paths, retainedSpan());
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare('UPDATE factory_diagnostics SET finished_at=?').run(
      '2000-01-01T00:00:00.000Z',
    );
  } finally {
    db.close();
  }
  for (const query of [{}, { workItemId: 'work-test' }])
    expect(() => listFactoryDiagnostics(paths, query)).toThrow(v.ValiError);
  const response = await request('/tasks/work-test/preview');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual(retainedError);
});
it('guards malformed span JSON before SQLite extraction and returns safe preview errors', async () => {
  appendDiagnostic(paths, retainedSpan());
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare('UPDATE factory_diagnostics SET record_json=?').run(
      'private-invalid-json',
    );
  } finally {
    db.close();
  }
  for (const query of [{}, { workItemId: 'work-test' }])
    expect(() => listFactoryDiagnostics(paths, query)).toThrow(SyntaxError);
  // Force evaluation of the JSON task predicate for a nonmatching index.
  expect(listFactoryDiagnostics(paths, { workItemId: 'other-task' })).toEqual({
    records: [],
    nextBefore: null,
  });
  const response = await request('/tasks/work-test/preview');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual(retainedError);
});
it('excludes healthy other-task, global and expired spans from scoped reads', async () => {
  const span = retainedSpan();
  appendDiagnostic(paths, span);
  appendDiagnostic(paths, {
    ...span,
    id: 'other-span',
    correlation: { workItemId: 'unknown-task' },
  });
  appendDiagnostic(paths, { ...span, id: 'global-span', correlation: {} });
  const db = openDb(paths.neondeckDatabase);
  try {
    const expired = {
      ...span,
      id: 'expired',
      finishedAt: '2000-01-01T00:00:00.000Z',
    };
    db.prepare(
      'INSERT INTO factory_diagnostics(work_item_id,finished_at,record_json) VALUES(?,?,?)',
    ).run('work-test', expired.finishedAt, JSON.stringify(expired));
  } finally {
    db.close();
  }
  expect(
    listFactoryDiagnostics(paths, { workItemId: 'work-test', limit: 1 }),
  ).toEqual({
    records: [{ ...span, sequence: 1 }],
    nextBefore: null,
  });
  expect(listFactoryDiagnostics(paths, { workItemId: 'absent-task' })).toEqual({
    records: [],
    nextBefore: null,
  });
  const response = await request('/tasks/work-test/preview');
  expect(response.status).toBe(200);
  expect((await response.json()).diagnostics.spans).toHaveLength(1);
  expect((await request('/tasks/unknown-task/preview')).status).toBe(404);
});
it.each(['github', 'coding', 'delivery'] as const)(
  'fails health and preview closed when the %s key contains another worker',
  async (worker) => {
    saveWorker(paths, { ...workerFixture('stopped'), worker });
    const db = openDb(paths.neondeckDatabase);
    try {
      db.prepare(
        'UPDATE factory_worker_health SET record_json=? WHERE worker=?',
      ).run(
        JSON.stringify({
          ...workerFixture('stopped'),
          worker: worker === 'github' ? 'coding' : 'github',
        }),
        worker,
      );
    } finally {
      db.close();
    }
    for (const path of [
      '/health',
      '/health?workId=work-test',
      '/tasks/work-test/preview',
    ]) {
      const response = await request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(retainedError);
    }
  },
);
it('preserves valid span cursors, optional correlation and nullable worker records', async () => {
  const span = retainedSpan();
  appendDiagnostic(paths, span);
  appendDiagnostic(paths, { ...span, id: 'global-span', correlation: {} });
  const all = listFactoryDiagnostics(paths);
  expect(all.records.map((record) => record.sequence)).toEqual([2, 1]);
  expect(all.records[0].correlation).toEqual({});
  expect(all.records[1]).toEqual({ ...span, sequence: 1 });
  const page = listFactoryDiagnostics(paths, { limit: 1 });
  expect(page.nextBefore).toBe(2);
  expect(
    listFactoryDiagnostics(paths, { before: page.nextBefore!, limit: 1 })
      .records,
  ).toEqual([all.records[1]]);
  saveWorker(paths, workerFixture('stopped'));
  const health = await request('/health');
  expect(health.status).toBe(200);
  expect((await health.json()).workers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        worker: 'coding',
        status: 'stopped',
        instanceId: null,
        ownerPid: null,
      }),
      expect.objectContaining({ worker: 'github', status: 'not-running' }),
      expect.objectContaining({ worker: 'delivery', status: 'not-running' }),
    ]),
  );
  const response = await request('/tasks/work-test/preview');
  expect(response.status).toBe(200);
  const preview = await response.json();
  expect(preview.diagnostics.spans).toHaveLength(1);
  expect(preview.diagnostics.spans[0]).toMatchObject({
    correlation: { workItemId: preview.workId },
    parentSpanId: null,
    error: null,
  });
});
it('rejects null-index foreign correlation and corrupted pagination lookahead', () => {
  const span = retainedSpan();
  appendDiagnostic(paths, { ...span, correlation: {} });
  appendDiagnostic(paths, { ...span, id: 'newer' });
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare(
      'UPDATE factory_diagnostics SET record_json=? WHERE sequence=1',
    ).run(JSON.stringify(span));
  } finally {
    db.close();
  }
  expect(() => listFactoryDiagnostics(paths, { limit: 1 })).toThrow(
    v.ValiError,
  );
});

it.each([
  'runId',
  'attemptId',
  'requestId',
  'releaseId',
  'workItemId',
  'worktree_id',
  'writer_slot',
] as const)(
  'canonically validates indexed coding identity %s across diagnostic routes',
  async (field) => {
    const run = insertRun('canonical');
    for (const path of diagnosticPaths)
      expect((await request(path)).status).toBe(200);
    const db = openDb(paths.neondeckDatabase);
    try {
      if (field === 'worktree_id' || field === 'writer_slot') {
        db.exec('PRAGMA foreign_keys=OFF');
        db.prepare(`UPDATE coding_runs SET ${field}=?`).run(
          field === 'worktree_id' ? 'private-mismatch' : null,
        );
      } else {
        if (field === 'runId' || field === 'attemptId')
          run[field] = 'private-mismatch';
        else run.snapshot[field] = 'private-mismatch';
        v.parse(codingRunRecordSchema, run);
        db.prepare('UPDATE coding_runs SET record_json=?').run(
          JSON.stringify(run),
        );
      }
    } finally {
      db.close();
    }
    for (const path of diagnosticPaths) {
      const response = await request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(retainedError);
    }
  },
);
it.each([
  'pipeline_id',
  'release_id',
  'initial_run_id',
  'initial_attempt_id',
  'work_item_id',
  'repo_id',
  'branch',
  'pr_number',
] as const)(
  'canonically validates indexed delivery identity %s across diagnostic routes',
  async (field) => {
    insertDelivery('canonical');
    for (const path of diagnosticPaths)
      expect((await request(path)).status).toBe(200);
    const db = openDb(paths.neondeckDatabase);
    try {
      if (field === 'work_item_id') {
        const delivery = deliveryFixture('canonical');
        delivery.workItemId = 'private-mismatch';
        db.prepare('UPDATE factory_delivery_pipelines SET record_json=?').run(
          JSON.stringify(delivery),
        );
      } else
        db.prepare(`UPDATE factory_delivery_pipelines SET ${field}=?`).run(
          field === 'pr_number' ? 123 : 'private-mismatch',
        );
    } finally {
      db.close();
    }
    for (const path of diagnosticPaths) {
      const response = await request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(retainedError);
    }
  },
);
it.each(['authorization', 'duplicate-effects', 'evidence-linkage'])(
  'rejects shape-valid delivery aggregate corruption: %s',
  async (corruption) => {
    insertDelivery('canonical');
    for (const path of diagnosticPaths)
      expect((await request(path)).status).toBe(200);
    const delivery = deliveryFixture('canonical');
    if (corruption === 'authorization')
      delivery.authorization.revision = {
        ...delivery.initialRevision,
        runId: 'private-mismatch',
      };
    else if (corruption === 'duplicate-effects')
      delivery.effects.push({ ...delivery.effects[0] });
    else {
      delivery.effects[0].kind = 'verification';
      delivery.evidence.push({
        id: 'evidence',
        kind: 'verification',
        revision: delivery.revision,
        producerId: 'independent',
        result: 'failed',
        evidenceRef: 'receipt',
        effectId: delivery.effects[0].id,
        validationContractDigest: deliveryValidationContractDigest(delivery),
        bundleDigest: 'b'.repeat(64),
        verificationEvidenceId: null,
        verificationBundleDigest: null,
      });
      const validDb = openDb(paths.neondeckDatabase);
      try {
        validDb
          .prepare('UPDATE factory_delivery_pipelines SET record_json=?')
          .run(JSON.stringify(delivery));
      } finally {
        validDb.close();
      }
      for (const path of diagnosticPaths)
        expect((await request(path)).status).toBe(200);
      delivery.evidence[0].effectId = 'missing-effect';
    }
    v.parse(deliveryPipelineSchema, delivery);
    const db = openDb(paths.neondeckDatabase);
    try {
      db.prepare('UPDATE factory_delivery_pipelines SET record_json=?').run(
        JSON.stringify(delivery),
      );
    } finally {
      db.close();
    }
    for (const path of diagnosticPaths) {
      const response = await request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(retainedError);
    }
  },
);

function insertWriteback(kind: string, record: Record<string, unknown>) {
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare(
      'INSERT INTO factory_writeback_records(id,kind,work_id,record) VALUES(?,?,?,?)',
    ).run(String(record.id), kind, 'work-test', JSON.stringify(record));
  } finally {
    db.close();
  }
}
function statusFixture() {
  return {
    id: 'status:work-test',
    workId: 'work-test',
    marker: 'm',
    remoteId: null,
    author: null,
    confirmedBody: null,
    confirmedUpdatedAt: null,
    relinquished: false,
  };
}
it.each(['', 'unknown', 'status', 'approval', 'repair', 'policy'])(
  'rejects missing, invalid or disagreeing indexed writeback kind %j',
  async (kind) => {
    insertWriteback('status', statusFixture());
    insertWriteback(kind, writebackFixture());
    for (const path of diagnosticPaths)
      expect((await request(path)).status).toBe(503);
  },
);
it.each([undefined, null, 'effect', 'invalid', 42, false, {}])(
  'rejects missing or invalid effect payload kind %j',
  async (kind) => {
    insertWriteback('status', statusFixture());
    insertWriteback('effect', { ...writebackFixture(), kind });
    for (const path of diagnosticPaths)
      expect((await request(path)).status).toBe(503);
  },
);
it.each(['status', 'effect'])(
  'rejects hybrid payload masquerading as %s',
  async (kind) => {
    insertWriteback(kind, { ...writebackFixture(), ...statusFixture() });
    for (const path of diagnosticPaths)
      expect((await request(path)).status).toBe(503);
  },
);
it('preserves valid non-effect records and legacy effect defaults', async () => {
  insertWriteback('status', statusFixture());
  insertWriteback('approval', {
    id: 'approval',
    workId: 'work-test',
    requestKey: 'request',
    expectedVersion: 1,
    specVersion: 1,
    specHash: 'h',
    sourceVersion: 1,
    issueId: 'issue',
    kind: 'question',
    body: 'approved question',
    decisionId: null,
    actor: 'human',
    approvedAt: recordedAt,
    bodyHash: 'h',
    epoch: 'e',
  });
  insertWriteback('repair', {
    id: 'repair',
    workId: 'work-test',
    effectId: 'old-pending',
    epoch: 'e',
    workVersion: 1,
    observed: null,
    replacement: 'replacement',
    expiresAt: 1,
  });
  insertWriteback('effect', writebackFixture());
  for (const path of diagnosticPaths)
    expect((await request(path)).status).toBe(200);
  const health = await (await request('/health?workId=work-test')).json();
  expect(health.tasks[0].unresolvedEffects).toHaveLength(1);
  expect(health.tasks[0].unresolvedEffects[0].effectId).toBe('old-pending');
});
it('bounds writeback candidates and validates the lookahead before reporting partial coverage', async () => {
  insertWriteback('invalid', writebackFixture());
  for (let i = 0; i < sourceLimit; i++)
    insertWriteback('status', { ...statusFixture(), id: `status-${i}` });
  for (const path of diagnosticPaths)
    expect((await request(path)).status).toBe(503);
  insertWriteback('status', { ...statusFixture(), id: 'status-lookahead' });
  for (const path of diagnosticPaths)
    expect((await request(path)).status).toBe(200);
  const health = await (await request('/health?workId=work-test')).json();
  expect(health).toMatchObject({
    truncated: true,
    tasks: [{ truncated: true }],
  });
  const preview = await (await request('/tasks/work-test/preview')).json();
  expect(preview.health.truncated).toBe(true);
  expect(preview.timeline.truncated).toBe(true);
});
it('fails safely on malformed writeback JSON before priority classification', async () => {
  insertWriteback('effect', writebackFixture());
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare('UPDATE factory_writeback_records SET record=?').run('{broken');
  } finally {
    db.close();
  }
  for (const path of diagnosticPaths) {
    const response = await request(path);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(retainedError);
  }
});
it('rejects a null indexed kind in a schema-drifted writeback table', async () => {
  const db = openDb(paths.neondeckDatabase);
  try {
    db.exec('DROP TABLE factory_writeback_records');
    db.exec(
      'CREATE TABLE factory_writeback_records(id TEXT PRIMARY KEY, kind TEXT, work_id TEXT, record TEXT NOT NULL)',
    );
    db.prepare('INSERT INTO factory_writeback_records VALUES(?,?,?,?)').run(
      'old-pending',
      null,
      'work-test',
      JSON.stringify(writebackFixture()),
    );
  } finally {
    db.close();
  }
  insertWriteback('status', statusFixture());
  for (const path of diagnosticPaths)
    expect((await request(path)).status).toBe(503);
});
it('does not read global policy or other-task writeback records', async () => {
  const db = openDb(paths.neondeckDatabase);
  try {
    const insert = db.prepare(
      'INSERT INTO factory_writeback_records VALUES(?,?,?,?)',
    );
    insert.run(
      'policy:connection',
      'policy',
      null,
      JSON.stringify({
        id: 'policy:connection',
        enabled: true,
        epoch: 'e',
        connectionFingerprint: 'f',
        actor: 'human',
        approvedAt: recordedAt,
      }),
    );
    insert.run('foreign', 'invalid', 'other-task', '{broken');
  } finally {
    db.close();
  }
  insertWriteback('effect', writebackFixture());
  for (const path of diagnosticPaths)
    expect((await request(path)).status).toBe(200);
});

it('previews the newest 100 timeline entries through the route, including undated current states', async () => {
  const middle = '2026-09-07T13:00:00.000Z';
  const recent = '2026-09-08T12:00:00.000Z';
  const db = openDb(paths.neondeckDatabase);
  try {
    const insert = db.prepare(
      'INSERT INTO factory_audit(work_id,action,actor,created_at) VALUES(?,?,?,?)',
    );
    for (let i = 0; i < 150; i++)
      insert.run('work-test', 'spec-saved', 'actor', middle);
  } finally {
    db.close();
  }
  insertWriteback('effect', {
    ...writebackFixture(),
    state: 'failed',
    createdAt: recent,
  });
  const response = await request('/tasks/work-test/preview');
  expect(response.status).toBe(200);
  const preview = await response.json();
  expect(preview.timeline.truncated).toBe(true);
  expect(preview.timeline.entries).toHaveLength(100);
  expect(preview.timeline.entries).toContainEqual(
    expect.objectContaining({ kind: 'effect', occurredAt: recent }),
  );
  expect(preview.timeline.entries.at(-1)).toMatchObject({
    kind: 'effect',
    occurredAt: null,
    correlation: { workItemId: preview.workId },
  });
  expect(preview.timeline.entries).not.toContainEqual(
    expect.objectContaining({ occurredAt: recordedAt }),
  );
  // The same retained history still starts chronologically in the interactive API.
  const firstPage = await (
    await request('/tasks/work-test/timeline?limit=100')
  ).json();
  expect(firstPage.entries[0].occurredAt).toBe(recordedAt);
  expect(firstPage.nextCursor).toBeTypeOf('string');
  expect(firstPage.coverage.truncated).toBe(false);
});

function queuedReleaseFixture() {
  const records = taskFixture();
  records.work.lifecycle = 'queued';
  records.work.repoId = 'repo';
  const revision = records.revisions[0];
  revision.hash = createHash('sha256')
    .update(JSON.stringify(revision.spec))
    .digest('hex');
  revision.repoFingerprint = 'a'.repeat(64);
  const release = v.parse(releaseSchema, {
    id: 'first-release',
    workId: records.work.id,
    requestKey: 'first-release',
    actor: 'human',
    specVersion: revision.version,
    specHash: revision.hash,
    sourceVersion: revision.sourceVersion,
    repoId: 'repo',
    repoFingerprint: revision.repoFingerprint,
    policy: factoryPolicy,
    createdAt: recordedAt,
    withdrawnAt: null,
    withdrawalReason: null,
  });
  return { records, revision, release };
}
it.each([
  'valid',
  'missing',
  'withdrawn',
  'stale-version',
  'repo',
  'hash',
  'spec-digest',
  'revision-hash',
  'revision-missing',
  'fingerprint',
  'source-version',
  'malformed-release',
  'malformed-revision',
  'work-binding',
  'revision-binding',
] as const)(
  'diagnoses first queued release without a reserved run: %s',
  async (fault) => {
    const { records, revision, release } = queuedReleaseFixture();
    if (fault === 'withdrawn') release.withdrawnAt = recordedAt;
    if (fault === 'stale-version') release.specVersion++;
    if (fault === 'repo') release.repoId = 'other';
    if (fault === 'hash') release.specHash = 'b'.repeat(64);
    if (fault === 'spec-digest')
      revision.spec.outcome = 'Changed without updating stored hash';
    if (fault === 'revision-hash') revision.hash = 'b'.repeat(64);
    if (fault === 'fingerprint') revision.repoFingerprint = 'b'.repeat(64);
    if (fault === 'source-version') release.sourceVersion++;
    if (fault === 'work-binding') release.workId = 'other';
    if (fault === 'revision-binding') revision.version++;
    const db = openDb(paths.neondeckDatabase);
    try {
      db.prepare('UPDATE factory_work_items SET record=?').run(
        JSON.stringify(records.work),
      );
      db.prepare('UPDATE factory_spec_revisions SET record=?').run(
        fault === 'malformed-revision'
          ? 'private-invalid-json'
          : JSON.stringify(revision),
      );
      if (fault === 'revision-missing')
        db.prepare('DELETE FROM factory_spec_revisions').run();
      if (fault !== 'missing')
        db.prepare(
          'INSERT INTO factory_releases(id,work_id,request_key,record) VALUES(?,?,?,?)',
        ).run(
          release.id,
          records.work.id,
          release.requestKey,
          fault === 'malformed-release'
            ? 'private-invalid-json'
            : JSON.stringify(release),
        );
      if (
        ![
          'malformed-release',
          'malformed-revision',
          'work-binding',
          'revision-binding',
        ].includes(fault)
      ) {
        expect(
          diagnoseHealth(
            [readTaskHealthRecords(db, records.work.id)],
            [workerFixture()],
            recordedAt,
          ),
        ).toMatchObject({
          status: fault === 'valid' ? 'healthy' : 'attention',
          tasks: [{ status: fault === 'valid' ? 'queued' : 'release-blocked' }],
        });
      }
      for (const path of ['/health', '/health?workId=work-test']) {
        const response = await request(path);
        const invalid = [
          'malformed-release',
          'malformed-revision',
          'work-binding',
          'revision-binding',
        ].includes(fault);
        expect(response.status).toBe(invalid ? 503 : 200);
        const body = await response.json();
        if (invalid)
          expect(JSON.stringify(body)).not.toContain('private-invalid-json');
        else
          expect(body.tasks[0].status).toBe(
            fault === 'valid' ? 'queued' : 'release-blocked',
          );
      }
      expect(db.prepare('SELECT count(*) AS n FROM coding_runs').get()?.n).toBe(
        0,
      );
      expect(
        db.prepare('SELECT count(*) AS n FROM factory_audit').get()?.n,
      ).toBe(1);
    } finally {
      db.close();
    }
  },
);
it.each([false, true])(
  'bounds queued release candidates and validates lookahead (malformed=%s)',
  async (malformed) => {
    const { records, revision, release } = queuedReleaseFixture();
    const db = openDb(paths.neondeckDatabase);
    try {
      db.prepare('UPDATE factory_work_items SET record=?').run(
        JSON.stringify(records.work),
      );
      db.prepare('UPDATE factory_spec_revisions SET record=?').run(
        JSON.stringify(revision),
      );
      for (let i = 0; i <= sourceLimit; i++) {
        const candidate = {
          ...release,
          id: `release-${i}`,
          requestKey: `release-${i}`,
        };
        db.prepare(
          'INSERT INTO factory_releases(id,work_id,request_key,record) VALUES(?,?,?,?)',
        ).run(
          candidate.id,
          records.work.id,
          candidate.requestKey,
          malformed && i === 0 ? 'bad' : JSON.stringify(candidate),
        );
      }
      if (!malformed)
        expect(
          diagnoseHealth(
            [readTaskHealthRecords(db, records.work.id)],
            [workerFixture()],
            recordedAt,
          ),
        ).toMatchObject({ status: 'attention', truncated: true });
      expect((await request('/health?workId=work-test')).status).toBe(
        malformed ? 503 : 200,
      );
    } finally {
      db.close();
    }
  },
);

it('keeps ongoing operations visible when future queued admission is blocked', () => {
  const { records, run } = faultCoexistenceFixture();
  records.releases[0].withdrawnAt = recordedAt;
  records.runs = [];
  const health = () => diagnoseHealth([records], [workerFixture()], recordedAt);
  expect(health()).toMatchObject({
    status: 'attention',
    tasks: [{ status: 'release-blocked' }],
  });
  records.planning = [
    {
      id: 'planning',
      workId: records.work.id,
      createdAt: recordedAt,
      stage: 'planner',
      submissionId: null,
      triageSubmissionId: null,
    },
  ];
  records.writeback = [
    v.parse(writebackEffectSchema, { ...writebackFixture(), state: 'pending' }),
  ];
  expect(health().tasks[0].status).toBe('release-blocked');
  records.runs = [run];
  expect(health().tasks[0]).toMatchObject({
    status: 'coding-reserved',
    nextStep: expect.stringContaining('Cancellation and reconciliation'),
  });
  records.runs = [];
  const delivery = deliveryFixture('ongoing');
  records.deliveries = [delivery];
  delivery.effects[0].state = 'in-flight';
  expect(health().tasks[0].status).toBe('delivery-pending');
  delivery.effects = [];
  delivery.progress.assessments = [assessmentFixture(delivery)];
  expect(health().tasks[0].status).toBe(
    `assessment-${delivery.progress.assessments[0].state}`,
  );
  delivery.progress.assessments[0].state = 'uncertain';
  expect(health().tasks[0].status).toBe('needs-reconciliation');
});

it('uses canonical first active release rather than accepting any matching release', () => {
  const { records, revision, release } = queuedReleaseFixture();
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare('UPDATE factory_work_items SET record=?').run(
      JSON.stringify(records.work),
    );
    db.prepare('UPDATE factory_spec_revisions SET record=?').run(
      JSON.stringify(revision),
    );
    const first = { ...release, repoId: 'wrong-repo' };
    const second = { ...release, id: 'second', requestKey: 'second' };
    for (const candidate of [first, second])
      db.prepare(
        'INSERT INTO factory_releases(id,work_id,request_key,record) VALUES(?,?,?,?)',
      ).run(
        candidate.id,
        records.work.id,
        candidate.requestKey,
        JSON.stringify(candidate),
      );
    const health = () =>
      diagnoseHealth(
        [readTaskHealthRecords(db, records.work.id)],
        [workerFixture()],
        recordedAt,
      );
    expect(health()).toMatchObject({
      status: 'attention',
      tasks: [{ status: 'release-blocked' }],
    });
    first.withdrawnAt = recordedAt;
    db.prepare('UPDATE factory_releases SET record=? WHERE id=?').run(
      JSON.stringify(first),
      first.id,
    );
    expect(health()).toMatchObject({
      status: 'healthy',
      tasks: [{ status: 'queued' }],
    });
  } finally {
    db.close();
  }
});
