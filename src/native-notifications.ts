import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { NotificationRecord } from './app-state';

export type NativeNotificationDelivery = {
  delivered: boolean;
  provider: 'macos-osascript' | 'disabled' | 'unsupported';
  reason?: string;
};

const attentionLevels = new Set(['attention', 'urgent']);

export function shouldDeliverNativeNotification(
  notification: Pick<NotificationRecord, 'level' | 'resolvedAt'>,
  env = process.env,
) {
  if (notification.resolvedAt) return false;
  if (env.NEONDECK_NATIVE_NOTIFICATIONS === '0') return false;
  if (env.NODE_ENV === 'test' && env.NEONDECK_NATIVE_NOTIFICATIONS !== '1') {
    return false;
  }
  return attentionLevels.has(notification.level);
}

export function deliverNativeNotification(
  notification: Pick<
    NotificationRecord,
    'level' | 'message' | 'resolvedAt' | 'source' | 'title'
  >,
  env = process.env,
): NativeNotificationDelivery {
  if (!shouldDeliverNativeNotification(notification, env)) {
    return { delivered: false, provider: 'disabled' };
  }

  if (platform() !== 'darwin') {
    return {
      delivered: false,
      provider: 'unsupported',
      reason: 'Native notifications are currently implemented for macOS.',
    };
  }

  const subprocess = spawn(
    'osascript',
    [
      '-e',
      `
on run argv
  set notificationTitle to item 1 of argv
  set notificationBody to item 2 of argv
  set notificationSubtitle to item 3 of argv
  if notificationSubtitle is "" then
    display notification notificationBody with title notificationTitle
  else
    display notification notificationBody with title notificationTitle subtitle notificationSubtitle
  end if
end run
`,
      notification.title,
      notification.message,
      notification.source ?? '',
    ],
    {
      detached: true,
      stdio: 'ignore',
    },
  );

  subprocess.on('error', (error) => {
    console.error('[neondeck] native notification failed', error);
  });
  subprocess.unref();

  return { delivered: true, provider: 'macos-osascript' };
}
