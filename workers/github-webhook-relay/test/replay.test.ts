import { env } from 'cloudflare:workers';
import { evictDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  githubWebhookEnvelopeSchema,
  githubWebhookReplayEnvelopeSchema,
  replayTruncatedFrameSchema,
} from '../src/protocol';
import {
  closeOpenSockets,
  nextMessage,
  openWebSocket,
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

// Builds rows for `seedEventLogForTest`, the DO's test-only bulk-insert RPC.
// It drives the exact same recordEvent/pruneEventLog path a real webhook
// does, without the per-request HTTP + HMAC cost of `sendGithubWebhook` —
// which matters here because these tests intentionally push past the
// 1000-row retention cap.
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
      const envelope = githubWebhookReplayEnvelopeSchema.parse(
        JSON.parse(await nextMessage(second)),
      );
      replayedIds.push(envelope.deliveryId);
    }

    expect(replayedIds).toEqual(missedIds);

    // Replay hands off to live delivery without dropping or duplicating.
    const liveId = syntheticDeliveryId('bbbbbbbb', 99);
    const liveMessage = nextMessage(second);
    await sendGithubWebhook({ channel, deliveryId: liveId });
    const liveEnvelope = githubWebhookEnvelopeSchema.parse(
      JSON.parse(await liveMessage),
    );
    expect(liveEnvelope.deliveryId).toBe(liveId);
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
    const envelope = githubWebhookReplayEnvelopeSchema.parse(
      JSON.parse(await nextMessage(second)),
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
    const frame = replayTruncatedFrameSchema.parse(
      JSON.parse(await nextMessage(socket)),
    );
    expect(frame).toEqual({ version: 1, type: 'replay.truncated' });
  });

  it('sets replayTruncated on a cursor pruned out of the log', async () => {
    const channel = 'replay-pruned-cursor';
    const room = env.RELAY_ROOMS.getByName(channel);
    const prunedId = syntheticDeliveryId('eeeeeeee', 0);
    const response = await sendGithubWebhook({ channel, deliveryId: prunedId });
    expect(response.status).toBe(200);

    // Push well past the retention cap so the delivery above is pruned out.
    await room.seedEventLogForTest({
      rows: syntheticEventRows('eeeeeeff', eventLogRetentionRows + 5),
    });

    const socket = await openWebSocket(
      channel,
      webSocketClientSecret,
      prunedId,
    );
    const frame = replayTruncatedFrameSchema.parse(
      JSON.parse(await nextMessage(socket)),
    );
    expect(frame.type).toBe('replay.truncated');
  });

  it('bounds event log growth past the retention limit', async () => {
    const channel = 'pruning-room';
    const room = env.RELAY_ROOMS.getByName(channel);

    await room.seedEventLogForTest({
      rows: syntheticEventRows('11111111', eventLogRetentionRows + 50),
    });
    const seededStats = await room.getEventLogDiagnostics();
    expect(seededStats.rowCount).toBeGreaterThan(0);
    expect(seededStats.rowCount).toBeLessThanOrEqual(eventLogRetentionRows);

    // The production insert path prunes the same way on top of seeded rows.
    const liveId = syntheticDeliveryId('22222222', 0);
    const response = await sendGithubWebhook({ channel, deliveryId: liveId });
    expect(response.status).toBe(200);
    const liveStats = await room.getEventLogDiagnostics();
    expect(liveStats.rowCount).toBeLessThanOrEqual(eventLogRetentionRows);
  });
});
