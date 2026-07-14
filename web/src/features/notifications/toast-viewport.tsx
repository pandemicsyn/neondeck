import { createPortal } from 'react-dom';
import type { DashboardDensity } from '../../api';
import { resolveNotificationTarget } from './targets';
import { ToastRow } from './toast-row';
import type { ToastItem } from './types';

export function ToastViewport({
  actionErrors,
  density,
  items,
  onAcknowledge,
  onDismiss,
  onOpen,
  pendingIds,
  statuslinePosition,
}: {
  actionErrors: Record<string, string | undefined>;
  density: DashboardDensity;
  items: ToastItem[];
  onAcknowledge: (item: ToastItem) => void;
  onDismiss: (item: ToastItem) => void;
  onOpen: (item: ToastItem) => void;
  pendingIds: ReadonlySet<string>;
  statuslinePosition?: 'top' | 'bottom';
}) {
  if (typeof document === 'undefined' || items.length === 0) return null;

  return createPortal(
    <aside
      aria-label="Notifications"
      className={`notification-toast-viewport toast-density-${density} ${
        statuslinePosition === 'bottom' ? 'toast-above-statusline' : ''
      }`}
    >
      {items.map((item) => (
        <ToastRow
          actionError={actionErrors[item.notification.id]}
          item={item}
          key={item.notification.id}
          onAcknowledge={() => onAcknowledge(item)}
          onDismiss={() => onDismiss(item)}
          onOpen={() => onOpen(item)}
          pending={pendingIds.has(item.notification.id)}
          target={resolveNotificationTarget(item.notification)}
        />
      ))}
    </aside>,
    document.body,
  );
}
