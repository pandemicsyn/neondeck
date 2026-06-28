import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../lib/cn';

type MarkdownMessageProps = {
  children: string;
  className?: string;
};

export function MarkdownMessage({
  children,
  className,
}: MarkdownMessageProps) {
  return (
    <div className={cn('chat-markdown', className)}>
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
