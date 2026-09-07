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
  expect(preview.health).toHaveProperty('truncated', false);
  expect(preview.health.tasks[0]).toHaveProperty('truncated', false);
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
      JSON.stringify({ ...delivery, outcome }),
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
      expect(response.status).toBe(state === 'uncertain' ? 503 : 200);
      expect(await response.json()).toMatchObject(
        state === 'uncertain'
          ? { error: 'Task record binding is inconsistent.' }
          : { tasks: [{ unresolvedEffects: [] }] },
      );
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
it.each(['runId', 'workItemId'])(
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
            snapshot: { ...run.snapshot, requestId: id, releaseId: id },
          }),
        );
      }
      db.prepare('UPDATE coding_runs SET record_json=? WHERE run_id=?').run(
        JSON.stringify(
          field === 'runId'
            ? { ...run, runId: 'foreign' }
            : {
                ...run,
                snapshot: { ...run.snapshot, workItemId: 'foreign' },
              },
        ),
        run.runId,
      );
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
      const work = { ...taskFixture().work, lifecycle, repoId: 'repo' };
      db.prepare('UPDATE factory_work_items SET record=? WHERE id=?').run(
        JSON.stringify(work),
        work.id,
      );
      db.prepare('UPDATE coding_runs SET record_json=? WHERE run_id=?').run(
        JSON.stringify(failed),
        run.runId,
      );
      const release = {
        id: 'release',
        workId: work.id,
        requestKey: 'release',
        actor: 'human',
        specVersion: 1,
        specHash: 'a'.repeat(64),
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
        db.prepare('UPDATE coding_runs SET record_json=? WHERE run_id=?').run(
          JSON.stringify(terminal),
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
        expect(status()).toBe(lifecycle);
        db.prepare('UPDATE factory_releases SET record=? WHERE id=?').run(
          JSON.stringify(release),
          release.id,
        );
      }
      db.prepare('UPDATE coding_runs SET record_json=? WHERE run_id=?').run(
        JSON.stringify(failed),
        run.runId,
      );
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
        expect(status()).toBe(lifecycle);
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
        expect(status()).toBe(lifecycle);
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
        db.prepare('UPDATE coding_runs SET record_json=? WHERE run_id=?').run(
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
      db.prepare('UPDATE coding_runs SET record_json=? WHERE run_id=?').run(
        JSON.stringify({ ...run, status: 'needs-reconcile' }),
        run.runId,
      );
      expect(status()).toBe('needs-reconciliation');
      db.prepare('UPDATE coding_runs SET record_json=? WHERE run_id=?').run(
        JSON.stringify(run),
        run.runId,
      );
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
      specHash: 'a'.repeat(64),
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
