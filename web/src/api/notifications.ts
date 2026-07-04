import type { NotificationResponse } from './types';
import { getJson, postJson } from './http';

export async function getNotifications() {
  return getJson<NotificationResponse>('/api/notifications');
}

export async function markNotificationRead(id: string) {
  return postJson<{ ok: boolean }>(`/api/notifications/${id}/read`, {});
}

export async function resolveNotification(id: string) {
  return postJson<{ ok: boolean }>(`/api/notifications/${id}/resolve`, {});
}
