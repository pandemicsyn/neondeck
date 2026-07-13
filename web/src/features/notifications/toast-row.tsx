import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { relativeTime } from '../../lib/format';
import type { NotificationTarget, ToastItem } from './types';

export function ToastRow({
  actionError,
  item,
  onAcknowledge,
  onDismiss,
  onOpen,
  pending,
  target,
}: {
  actionError?: string;
  item: ToastItem;
  onAcknowledge: () => void;
  onDismiss: () => void;
  onOpen: () => void;
  pending: boolean;
  target: NotificationTarget;
}) {
  const { notification } = item;
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const remainingRef = useRef(
    item.expiresAt === null ? null : Math.max(0, item.expiresAt - Date.now()),
  );
  const startedAtRef = useRef(Date.now());

  useEffect(() => {
    remainingRef.current =
      item.expiresAt === null ? null : Math.max(0, item.expiresAt - Date.now());
    startedAtRef.current = Date.now();
  }, [item.expiresAt, notification.updatedAt]);

  useEffect(() => {
    const remaining = remainingRef.current;
    if (remaining === null || hovered || focusWithin || pending) return;
    startedAtRef.current = Date.now();
    const timeout = window.setTimeout(onDismiss, remaining);
    return () => {
      window.clearTimeout(timeout);
      remainingRef.current = Math.max(
        0,
        remaining - (Date.now() - startedAtRef.current),
      );
    };
  }, [
    onDismiss,
    hovered,
    focusWithin,
    pending,
    item.expiresAt,
    notification.updatedAt,
  ]);
  const assertive =
    notification.level === 'attention' || notification.level === 'urgent';

  return (
    // Toast containers intentionally coordinate hover, focus, and Escape so
    // transient timers pause without making the announcement itself focusable.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/prefer-tag-over-role
    <article
      aria-atomic="true"
      aria-busy={pending}
      aria-labelledby={`toast-title-${notification.id}`}
      className={`notification-toast notification-toast-${notification.level}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocusWithin(false);
        }
      }}
      onFocus={() => setFocusWithin(true)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onDismiss();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role={assertive ? 'alert' : 'status'}
    >
      <div className="notification-toast-heading">
        <span className="notification-toast-level">{notification.level}</span>
        <span className="notification-toast-meta">
          {relativeTime(notification.updatedAt)}
          {notification.occurrenceCount > 1
            ? ` · ×${notification.occurrenceCount}`
            : ''}
        </span>
        <button
          aria-label={`Dismiss ${notification.title}`}
          className="notification-toast-close"
          onClick={onDismiss}
          type="button"
        >
          ×
        </button>
      </div>
      <h2 id={`toast-title-${notification.id}`}>{notification.title}</h2>
      <p>{notification.message}</p>
      {actionError ? (
        <p className="notification-toast-error">{actionError}</p>
      ) : null}
      <div className="notification-toast-actions">
        <Button disabled={pending} onClick={onOpen} type="button">
          {target.label}
        </Button>
        <Button disabled={pending} onClick={onAcknowledge} type="button">
          Acknowledge
        </Button>
      </div>
    </article>
  );
}
