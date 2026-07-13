import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { briefingProfileUpdateSchema, briefingRunNowSchema } from './schemas';
import {
  readBriefingRunDetails,
  readBriefingState,
  rotateBriefingSession,
  runBriefingNow,
  updateBriefingProfile,
} from './service';

const outputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.optional(v.string()),
});

export const briefingProfileReadAction = defineAction({
  name: 'neondeck_briefing_profile_read',
  description:
    'Read the typed morning briefing profile, its durable conversation link, and recent operational run metadata.',
  input: v.object({}),
  output: outputSchema,
  async run() {
    return readBriefingState();
  },
});

export const briefingProfileUpdateAction = defineAction({
  name: 'neondeck_briefing_profile_update',
  description:
    'Update the enabled state, cron schedule, timezone, title, or user-authored instructions for the morning briefing profile.',
  input: briefingProfileUpdateSchema,
  output: outputSchema,
  async run({ input }) {
    return updateBriefingProfile(input);
  },
});

export const briefingRunReadAction = defineAction({
  name: 'neondeck_briefing_run_read',
  description:
    'Read one exact persisted deterministic briefing snapshot and its operational dispatch metadata. This never reads or parses the assistant transcript.',
  input: v.object({ id: v.pipe(v.string(), v.minLength(1)) }),
  output: outputSchema,
  async run({ input }) {
    return readBriefingRunDetails(input.id);
  },
});

export const briefingRunNowAction = defineAction({
  name: 'neondeck_briefing_run_now',
  description:
    'Queue an informational briefing in its persistent briefing conversation. All configured display-assistant MCP tools remain available under their normal auth and approval controls.',
  input: briefingRunNowSchema,
  output: outputSchema,
  async run({ input }) {
    return runBriefingNow(input);
  },
});

export const briefingSessionRotateAction = defineAction({
  name: 'neondeck_briefing_session_rotate',
  description:
    'Explicitly start a fresh durable briefing conversation when its captured model, SOUL, memory, skill, or provider context is stale. The old transcript remains preserved.',
  input: v.object({ id: v.optional(v.string()) }),
  output: outputSchema,
  async run({ input }) {
    return rotateBriefingSession(input);
  },
});

export const neondeckBriefingActions = [
  briefingProfileReadAction,
  briefingProfileUpdateAction,
  briefingRunReadAction,
  briefingRunNowAction,
  briefingSessionRotateAction,
];
