import type { NotificationRecord } from '../../api';
import type { NotificationTarget } from './types';

export function resolveNotificationTarget(
  notification: NotificationRecord,
): NotificationTarget {
  const data = asRecord(notification.data);
  const preparedDiffId = readString(data.preparedDiffId);
  if (preparedDiffId) {
    return {
      kind: 'plugin',
      pluginId: 'autopilot',
      label: 'Open autopilot',
    };
  }

  const reviewUrl = readInternalPath(data.reviewUrl);
  if (reviewUrl) {
    return { kind: 'url', href: reviewUrl, label: 'Open review' };
  }

  const reportUrl = readInternalPath(data.reportUrl);
  if (reportUrl) {
    return { kind: 'url', href: reportUrl, label: 'Open report' };
  }

  const sessionId = readString(data.sessionId);
  if (sessionId && isSessionSource(notification.source)) {
    return { kind: 'session', sessionId, label: 'Open session' };
  }

  if (
    readString(data.taskId) ||
    readString(data.kiloTaskId) ||
    notification.source === 'kilo'
  ) {
    return {
      kind: 'plugin',
      pluginId: 'runtime-overview',
      label: 'Open tasks',
    };
  }

  if (
    readString(data.approvalId) ||
    notification.source?.includes('approval') ||
    notification.source === 'execution' ||
    notification.source === 'mcp'
  ) {
    return {
      kind: 'plugin',
      pluginId: 'runtime-overview',
      label: 'Open approvals',
    };
  }

  if (
    notification.source === 'flue' ||
    readString(data.runId) ||
    readString(data.workflow)
  ) {
    return {
      kind: 'plugin',
      pluginId: 'workflow-observability',
      label: 'Inspect run',
    };
  }

  if (notification.source?.includes('watch')) {
    return {
      kind: 'plugin',
      pluginId: 'active-watches',
      label: 'Open watches',
    };
  }

  if (notification.source === 'autopilot') {
    return {
      kind: 'plugin',
      pluginId: 'autopilot',
      label: 'Open autopilot',
    };
  }

  return {
    kind: 'plugin',
    pluginId: 'runtime-overview',
    label: 'Open notifications',
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readInternalPath(value: unknown) {
  const path = readString(value);
  return path?.startsWith('/') && !path.startsWith('//') ? path : undefined;
}

function isSessionSource(source: string | null) {
  return (
    source === 'briefing' ||
    source === 'execution' ||
    source === 'mcp' ||
    source?.includes('approval') === true
  );
}
