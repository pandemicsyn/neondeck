import type {
  BriefingMutationResponse,
  BriefingProfile,
  BriefingStateResponse,
} from './types';
import { getJson, postJson, putJson, type ApiRequestOptions } from './http';

export async function getBriefingState(options: ApiRequestOptions = {}) {
  return getJson<BriefingStateResponse>('/api/briefings', options);
}

export async function updateBriefingProfile(
  input: Partial<
    Pick<
      BriefingProfile,
      'name' | 'enabled' | 'instructions' | 'schedule' | 'timezone'
    >
  >,
) {
  return putJson<BriefingMutationResponse>('/api/briefings/profile', input);
}

export async function runBriefing(
  input: {
    profileId?: string;
    sessionId?: string;
    commandEventId?: string;
    trigger?: 'manual' | 'dashboard';
  } = {},
) {
  return postJson<BriefingMutationResponse>('/api/briefings/run', input);
}

export async function rotateBriefingSession(id = 'morning') {
  return postJson<BriefingMutationResponse>('/api/briefings/session/rotate', {
    id,
  });
}
