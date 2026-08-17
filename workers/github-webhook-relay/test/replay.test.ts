import { env } from 'cloudflare:workers';
import { evictDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventLogRow } from '../src/protocol';
import {
  githubWebhookEnvelopeSchema,
  githubWebhookReplayEnvelopeSchema,
  replayTruncatedFrameSchema,
} from '../src/protocol';
import {
  closeOpenSockets,
  getEventLogRowCount,
  nextEnvelope,
  nextMessage,
  openWebSocket,
  pullRequestWebhookPayload,
  seedEventLog,
  sendGithubWebhook,
  webSocketClientSecret,
} from './helpers';

// The Durable Object retains roughly 1000 rows (see relay-room.ts). Tests
// that need to push past the cap intentionally send more than this.
const eventLogRetentionRows = 1000;

afterEach(() => {
  closeOpenSockets();
});

function syntheticDeliveryId(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

// Builds rows for `seedEventLog` (see helpers.ts), which drives the exact
// same recordEvent/pruneEventLog path a real webhook does via
// `runInDurableObject`, without the per-request HTTP + HMAC cost of
// `sendGithubWebhook` — which matters here because these tests
// intentionally push past the 1000-row retention cap.
function syntheticEventRows(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    deliveryId: syntheticDeliveryId(prefix, index),
    event: 'pull_request',
    action: 'opened',
    repository: 'owner/repository',
    prNumber: null,
    receivedAt: new Date(Date.now() - (count - index) * 1000).toISOString(),
  }));
}

describe('event log replay', () => {
  it('replays exactly the events missed while disconnected, in order', async () => {
    const channel = 'replay-basic';
    const baselineId = syntheticDeliveryId('aaaaaaaa', 1);

    const first = await openWebSocket(channel);
    const baselineMessage = nextMessage(first);
    await sendGithubWebhook({ channel, deliveryId: baselineId });
    await baselineMessage;
    first.close(1000, 'Test disconnect.');

    const missedIds = [
      syntheticDeliveryId('bbbbbbbb', 1),
      syntheticDeliveryId('bbbbbbbb', 2),
      syntheticDeliveryId('bbbbbbbb', 3),
    ];
    for (const deliveryId of missedIds) {
      const response = await sendGithubWebhook({ channel, deliveryId });
      expect(response.status).toBe(200);
    }

    const second = await openWebSocket(
      channel,
      webSocketClientSecret,
      baselineId,
    );
    const replayedIds: string[] = [];
    for (let index = 0; index < missedIds.length; index += 1) {
      const envelope = await nextEnvelope(
        second,
        githubWebhookReplayEnvelopeSchema,
      );
      replayedIds.push(envelope.deliveryId);
    }

    expect(replayedIds).toEqual(missedIds);

    // Replay hands off to live delivery without dropping or duplicating.
    const liveId = syntheticDeliveryId('bbbbbbbb', 99);
    const liveEnvelopePromise = nextEnvelope(
      second,
      githubWebhookEnvelopeSchema,
    );
    await sendGithubWebhook({ channel, deliveryId: liveId });
    expect((await liveEnvelopePromise).deliveryId).toBe(liveId);
  });

  it('replays across Durable Object eviction', async () => {
    const channel = 'replay-eviction';
    const room = env.RELAY_ROOMS.getByName(channel);
    const baselineId = syntheticDeliveryId('cccccccc', 1);

    const first = await openWebSocket(channel);
    const baselineMessage = nextMessage(first);
    await sendGithubWebhook({ channel, deliveryId: baselineId });
    await baselineMessage;
    first.close(1000, 'Test disconnect.');

    await evictDurableObject(room);

    const missedId = syntheticDeliveryId('cccccccc', 2);
    const response = await sendGithubWebhook({ channel, deliveryId: missedId });
    expect(response.status).toBe(200);

    await evictDurableObject(room);

    const second = await openWebSocket(
      channel,
      webSocketClientSecret,
      baselineId,
    );
    const envelope = await nextEnvelope(
      second,
      githubWebhookReplayEnvelopeSchema,
    );
    expect(envelope.deliveryId).toBe(missedId);
  });

  it('sets replayTruncated on a cursor the channel has never seen', async () => {
    const channel = 'replay-unknown-cursor';
    const unknownId = syntheticDeliveryId('dddddddd', 1);

    const socket = await openWebSocket(
      channel,
      webSocketClientSecret,
      unknownId,
    );
    const frame = await nextEnvelope(socket, replayTruncatedFrameSchema);
    expect(frame).toEqual({ version: 1, type: 'replay.truncated' });
  });

  it('sets replayTruncated on a cursor pruned out of the log', async () => {
    const channel = 'replay-pruned-cursor';
    const room = env.RELAY_ROOMS.getByName(channel);
    const prunedId = syntheticDeliveryId('eeeeeeee', 0);
    const response = await sendGithubWebhook({ channel, deliveryId: prunedId });
    expect(response.status).toBe(200);

    // Push well past the retention cap so the delivery above is pruned out.
    await seedEventLog(
      room,
      syntheticEventRows('eeeeeeff', eventLogRetentionRows + 5),
    );

    const socket = await openWebSocket(
      channel,
      webSocketClientSecret,
      prunedId,
    );
    const frame = await nextEnvelope(socket, replayTruncatedFrameSchema);
    expect(frame.type).toBe('replay.truncated');
  });

  it('does not persist a duplicate row for a GitHub redelivery', async () => {
    // The existing github-webhook.test.ts redelivery test only asserts
    // that both responses' `deliveryId` match — it never checks whether a
    // second row was actually written. `INSERT OR IGNORE` on the unique
    // `deliveryId` column is what's supposed to prevent that; this asserts
    // the row count directly, which is the only way to prove the dedup
    // actually happened rather than merely that the API response looked
    // right twice.
    const channel = 'redelivery-row-count';
    const room = env.RELAY_ROOMS.getByName(channel);
    const deliveryId = '6a8f7d3e-9b1a-4c9e-8f8b-1a2b3c4d5e6f';

    const first = await sendGithubWebhook({ channel, deliveryId });
    expect(first.status).toBe(200);
    expect(await getEventLogRowCount(room)).toBe(1);

    const second = await sendGithubWebhook({ channel, deliveryId });
    expect(second.status).toBe(200);
    expect(await getEventLogRowCount(room)).toBe(1);
  });

  it('extracts prNumber consistently on both the live and replayed frame for the same delivery', async () => {
    // No existing fixture anywhere includes `pull_request` or `issue`, so
    // `prNumber` was null in 100% of prior test runs — both the extraction
    // itself and its propagation into the replay path had zero coverage.
    // This connects a baseline socket to get a replay cursor, delivers a
    // realistic pull_request webhook live (captured on that same socket),
    // then reconnects with `since` set to the baseline cursor so the same
    // delivery comes back as a *replay* frame, and checks both frames
    // agree on a non-null prNumber.
    const channel = 'pr-number-live-and-replay';
    const baselineId = 'aaaaaaaa-0000-4000-8000-000000000000';

    const baselineSocket = await openWebSocket(channel);
    const baselineMessage = nextMessage(baselineSocket);
    await sendGithubWebhook({ channel, deliveryId: baselineId });
    await baselineMessage;

    const deliveryId = 'bbbbbbbb-0000-4000-8000-000000000000';
    const liveEnvelopePromise = nextEnvelope(
      baselineSocket,
      githubWebhookEnvelopeSchema,
    );
    const response = await sendGithubWebhook({
      channel,
      deliveryId,
      event: 'pull_request',
      payload: pullRequestWebhookPayload,
    });
    expect(response.status).toBe(200);
    const liveEnvelope = await liveEnvelopePromise;
    expect(liveEnvelope.deliveryId).toBe(deliveryId);
    expect(liveEnvelope.prNumber).not.toBeNull();

    const replaySocket = await openWebSocket(
      channel,
      webSocketClientSecret,
      baselineId,
    );
    const replayEnvelope = await nextEnvelope(
      replaySocket,
      githubWebhookReplayEnvelopeSchema,
    );
    expect(replayEnvelope.deliveryId).toBe(deliveryId);
    expect(replayEnvelope.prNumber).toBe(liveEnvelope.prNumber);
  });

  it('bounds event log growth past the retention limit', async () => {
    const channel = 'pruning-room';
    const room = env.RELAY_ROOMS.getByName(channel);

    await seedEventLog(
      room,
      syntheticEventRows('11111111', eventLogRetentionRows + 50),
    );
    const seededRowCount = await getEventLogRowCount(room);
    expect(seededRowCount).toBeGreaterThan(0);
    expect(seededRowCount).toBeLessThanOrEqual(eventLogRetentionRows);

    // The production insert path prunes the same way on top of seeded rows.
    const liveId = syntheticDeliveryId('22222222', 0);
    const response = await sendGithubWebhook({ channel, deliveryId: liveId });
    expect(response.status).toBe(200);
    const liveRowCount = await getEventLogRowCount(room);
    expect(liveRowCount).toBeLessThanOrEqual(eventLogRetentionRows);
  });

  it('prunes events older than the 24h retention window independent of the row-count cap', async () => {
    // `pruneEventLog` has two independent cutoffs — 24h and 1000 rows —
    // but every other fixture in this suite uses recent timestamps, so
    // only the row-count branch has ever run. This seeds two rows already
    // past the 24h window alongside one fresh row, well under the 1000-row
    // cap, so the row-count branch cannot be what prunes anything here: if
    // the time-based DELETE were ever dropped, all three rows would
    // survive and this would read 3, not 1.
    const channel = 'time-based-retention';
    const room = env.RELAY_ROOMS.getByName(channel);
    const now = Date.now();

    const staleRows: EventLogRow[] = [
      {
        deliveryId: syntheticDeliveryId('ffffffff', 0),
        event: 'pull_request',
        action: 'opened',
        repository: 'owner/repository',
        prNumber: null,
        receivedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
      },
      {
        deliveryId: syntheticDeliveryId('ffffffff', 1),
        event: 'pull_request',
        action: 'opened',
        repository: 'owner/repository',
        prNumber: null,
        receivedAt: new Date(now - 30 * 60 * 60 * 1000).toISOString(),
      },
    ];
    const freshRow: EventLogRow = {
      deliveryId: syntheticDeliveryId('ffffffff', 2),
      event: 'pull_request',
      action: 'opened',
      repository: 'owner/repository',
      prNumber: null,
      receivedAt: new Date(now).toISOString(),
    };

    await seedEventLog(room, [...staleRows, freshRow]);

    expect(await getEventLogRowCount(room)).toBe(1);
  });
});
