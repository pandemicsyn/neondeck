import { useId, useState } from 'react';
import { Button } from '../../components/ui';

export function PreparedRevisionComposer({
  actionLabel,
  defaultReason = '',
  description,
  isPending,
  onCancel,
  onConfirm,
  requireReason,
  showRunNow,
}: {
  actionLabel: string;
  defaultReason?: string;
  description?: string;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: (input: { reason: string; runRevisionNow: boolean }) => void;
  requireReason: boolean;
  showRunNow: boolean;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState(defaultReason);
  const [runRevisionNow, setRunRevisionNow] = useState(true);
  const reasonRequired = requireReason && (!showRunNow || runRevisionNow);
  const disabled = isPending || (reasonRequired && !reason.trim());

  return (
    <div className="mt-2 border border-accent/50 bg-field px-2 py-1.5 font-mono text-[10px] text-muted">
      {description ? <p className="mb-1.5 leading-4">{description}</p> : null}
      <label className="sr-only" htmlFor={reasonId}>
        Revision reason
      </label>
      <textarea
        className="min-h-[64px] w-full resize-y border border-line bg-panel px-2 py-1.5 text-[11px] leading-4 text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        id={reasonId}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Revision note"
        value={reason}
      />
      {showRunNow ? (
        <label className="mt-1.5 flex items-center gap-1.5">
          <input
            checked={runRevisionNow}
            className="accent-[var(--color-accent)]"
            onChange={(event) => setRunRevisionNow(event.target.checked)}
            type="checkbox"
          />
          <span>run revision now</span>
        </label>
      ) : null}
      <div className="mt-1.5 flex justify-end gap-1.5">
        <Button
          className="min-h-[24px] border-accent bg-transparent px-1.5 py-0 text-[10px] text-accent"
          disabled={disabled}
          onClick={() => onConfirm({ reason: reason.trim(), runRevisionNow })}
          type="button"
        >
          {isPending ? 'saving' : actionLabel}
        </Button>
        <Button
          className="min-h-[24px] bg-transparent px-1.5 py-0 text-[10px]"
          disabled={isPending}
          onClick={onCancel}
          type="button"
        >
          cancel
        </Button>
      </div>
    </div>
  );
}
