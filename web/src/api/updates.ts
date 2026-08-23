import type { UpdateStatus } from './types';
import { getJson, postJson, type ApiRequestOptions } from './http';

export async function getUpdateStatus(options: ApiRequestOptions = {}) {
  return getJson<UpdateStatus>('/api/update-status', options);
}

export async function checkForUpdates() {
  return postJson<UpdateStatus>('/api/update-status/check', {});
}

export async function dismissUpdate(version: string) {
  return postJson<UpdateStatus>(
    `/api/update-status/${encodeURIComponent(version)}/dismiss`,
    {},
  );
}
