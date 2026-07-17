import { useId, useState } from 'react';
import { cn } from '../lib/cn';

const defaultDisclosureThreshold = 84;

type OperationalValueProps = {
  className?: string;
  disclosureThreshold?: number;
  label: string;
  preview?: string;
  previewClassName?: string;
  value: string;
};

export function OperationalValue({
  className,
  disclosureThreshold = defaultDisclosureThreshold,
  label,
  value,
  preview = value,
  previewClassName,
}: OperationalValueProps) {
  const actionLabelId = useId();
  const previewLabelId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const shouldDisclose =
    preview !== value ||
    value.length > disclosureThreshold ||
    value.includes('\n');
  const summaryPreview =
    preview.length > disclosureThreshold
      ? `${preview.slice(0, disclosureThreshold - 1)}…`
      : preview;

  if (!shouldDisclose) {
    return (
      <span className={cn('min-w-0', previewClassName, className)}>
        {preview}
      </span>
    );
  }

  async function copyValue() {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard access is unavailable.');
      }
      await navigator.clipboard.writeText(value);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }

  return (
    <details
      className={cn('min-w-0', className)}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary
        aria-labelledby={`${actionLabelId} ${previewLabelId}`}
        className="flex min-w-0 cursor-pointer list-none items-baseline gap-1 [&::-webkit-details-marker]:hidden"
        title={value.length <= disclosureThreshold * 2 ? value : undefined}
      >
        <span className="sr-only" id={actionLabelId}>
          {isOpen ? 'Hide' : 'Show'} full {label}.
        </span>
        <span
          className={cn('min-w-0 flex-1', previewClassName)}
          id={previewLabelId}
        >
          {summaryPreview}
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-[9.5px] text-violet"
        >
          {isOpen ? 'hide' : 'full'}
        </span>
      </summary>
      {isOpen ? (
        <div className="mt-1 flex min-w-0 items-start gap-1.5 border border-line bg-field px-2 py-1.5">
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[10px] leading-4 text-ink">
            {value}
          </code>
          <button
            aria-label={`Copy ${label}`}
            className="shrink-0 border border-line px-1.5 py-0.5 font-mono text-[9.5px] text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            onClick={() => void copyValue()}
            type="button"
          >
            copy
          </button>
          <output aria-live="polite" className="sr-only">
            {copyStatus === 'copied'
              ? `${label} copied.`
              : copyStatus === 'failed'
                ? `Could not copy ${label}.`
                : ''}
          </output>
        </div>
      ) : null}
    </details>
  );
}
