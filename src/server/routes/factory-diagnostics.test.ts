import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import * as v from 'valibot';
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
it('excludes validated terminal deliveries while retaining the newest active delivery and truncation', async () => {
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
  response = await request('/health?workId=work-test');
  expect(await response.json()).toMatchObject({
    truncated: true,
    tasks: [
      {
        truncated: true,
        budgets: [{ deliveryId: deliveryFixture('newer-active').pipelineId }],
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
