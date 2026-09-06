import { MarkdownMessage } from './MarkdownMessage';
/** Shared narrative typography for human review briefs. No review authority. */
export function BriefingNarrative({
  children,
  className = 'mt-3 max-w-[78ch]',
}: {
  children: string;
  className?: string;
}) {
  return (
    <MarkdownMessage
      className={className}
      style={{ fontSize: '16.5px', lineHeight: 1.7, textWrap: 'pretty' }}
    >
      {children}
    </MarkdownMessage>
  );
}
