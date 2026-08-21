import type { NotificationRecord } from '../../api';
import {
  externalRecord,
  type WebExternalRecord,
  type WebExternalValue,
} from '../../api/schemas';
import type { NotificationTarget } from './types';
import * as v from 'valibot';

export function resolveNotificationTarget(
  notification: NotificationRecord,
): NotificationTarget {
  const data = asRecord(notification.data);
  const preparedDiffId = readString(data.preparedDiffId);
  if (preparedDiffId) {
    return {
      kind: 'plugin',
      pluginId: 'active-watches',
      label: 'Open watches',
    };
  }
  const watchId = readString(data.watchId);
  if (watchId) {
    return {
      kind: 'plugin',
      pluginId: 'active-watches',
      label:
        readString(data.commitSha) ||
        readString(data.currentSha) ||
        readString(data.worktreeId)
          ? 'Review change'
          : 'Open watch',
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

  const detailUrl = readInternalPath(data.detailUrl);
  if (detailUrl) {
    return { kind: 'url', href: detailUrl, label: 'View activity' };
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
    readString(data.submissionId) ||
    readString(data.agentName)
  ) {
    return {
      kind: 'plugin',
      pluginId: 'activity',
      label: 'View activity',
    };
  }

  if (
    notification.source?.includes('watch') ||
    notification.source === 'autopilot'
  ) {
    return {
      kind: 'plugin',
      pluginId: 'active-watches',
      label: 'Open watches',
    };
  }

  return {
    kind: 'plugin',
    pluginId: 'runtime-overview',
    label: 'Open notifications',
  };
}

function asRecord(value: WebExternalValue): WebExternalRecord {
  return externalRecord(value) ?? {};
}

function readString(value: WebExternalValue) {
  const parsed = v.safeParse(v.pipe(v.string(), v.trim(), v.nonEmpty()), value);
  return parsed.success ? parsed.output : undefined;
}

function readInternalPath(value: WebExternalValue) {
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
