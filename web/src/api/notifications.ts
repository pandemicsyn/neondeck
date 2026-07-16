import type { NotificationResponse } from './types';
import { getJson, postJson, type ApiRequestOptions } from './http';

export async function getNotifications(options: ApiRequestOptions = {}) {
  return getJson<NotificationResponse>('/api/notifications', options);
}

export async function markNotificationRead(id: string) {
  return postJson<{ ok: boolean }>(`/api/notifications/${id}/read`, {});
}

export async function resolveNotification(id: string) {
  return postJson<{ ok: boolean }>(`/api/notifications/${id}/resolve`, {});
}
