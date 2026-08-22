import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../lib/cn';
import type { CSSProperties } from 'react';

type MarkdownMessageProps = {
  children: string;
  className?: string;
  style?: CSSProperties;
};

export function MarkdownMessage({
  children,
  className,
  style,
}: MarkdownMessageProps) {
  return (
    <div className={cn('chat-markdown', className)} style={style}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ children: linkChildren, ...props }) {
            return (
              <a rel="noreferrer" target="_blank" {...props}>
                {linkChildren}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
