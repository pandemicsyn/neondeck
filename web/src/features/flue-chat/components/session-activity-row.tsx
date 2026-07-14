import type { ChatSessionActivityItem } from '../../../api';
import { Badge } from '../../../components/ui';
import { relativeTime } from '../../../lib/format';
import { notificationDisplayMessage } from '../../../lib/watch-status';

export function SessionActivityRow({
  activity,
}: {
  activity: ChatSessionActivityItem;
}) {
  const state = activity.resolvedAt
    ? 'resolved'
    : activity.readAt
      ? 'read'
      : 'unread';

  return (
    <section
      aria-label={`Watch activity: ${activity.title}`}
      className="border-y border-line bg-field px-3 py-2"
    >
      <div className="flex items-center justify-between gap-3 font-mono text-[9.5px] leading-4 text-muted">
        <span className={activityLabelClass(activity.level)}>
          WATCH ACTIVITY · SYSTEM RECORD
        </span>
        <span className="shrink-0">{relativeTime(activity.updatedAt)}</span>
      </div>
      <div className="mt-1 flex items-start justify-between gap-3">
        <p className="text-[12px] font-medium leading-4 text-ink">
          {activity.title}
        </p>
        <Badge className={activityBadgeClass(activity.level)}>
          {activity.level}
        </Badge>
      </div>
      <p className="mt-1 text-[11px] leading-4 text-muted">
        {notificationDisplayMessage(activity)}
      </p>
      <p className="mt-1 font-mono text-[9.5px] leading-4 text-muted">
        {activity.source ?? 'local'} · {state}
        {activity.occurrenceCount > 1 ? ` · ×${activity.occurrenceCount}` : ''}
      </p>
    </section>
  );
}

function activityLabelClass(level: ChatSessionActivityItem['level']) {
  if (level === 'attention' || level === 'urgent') return 'text-accent';
  if (level === 'ready') return 'text-primary';
  return 'text-violet';
}

function activityBadgeClass(level: ChatSessionActivityItem['level']) {
  if (level === 'attention' || level === 'urgent') {
    return 'border-accent text-accent';
  }
  if (level === 'ready') return 'border-primary text-primary';
  return 'border-violet/60 text-violet';
}
