import type { FlueConversationPart } from '@flue/sdk';
import type { ReactNode } from 'react';
import { MarkdownMessage } from '../../../components/MarkdownMessage';
import { OperationalValue } from '../../../components/OperationalValue';

type LegacyToolResultPart = {
  type: 'tool-result';
  name: string;
  output: string;
};

type DynamicToolRenderPart = {
  type: 'dynamic-tool';
  toolName: string;
  toolCallId?: string;
  state: 'input-available' | 'output-available' | 'output-error';
  input: Parameters<typeof JSON.stringify>[0];
  output?: Parameters<typeof JSON.stringify>[0];
  errorText?: string;
};

export function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export function renderMessagePart(
  part: FlueConversationPart | LegacyToolResultPart | DynamicToolRenderPart,
  key: string,
): ReactNode {
  if (part.type === 'tool-result') {
    return (
      <ChatPartEvent
        key={key}
        kind="tool"
        name={part.name}
        preview={part.output}
      />
    );
  }
  if (part.type === 'text') {
    return part.text ? (
      <MarkdownMessage key={key}>{part.text}</MarkdownMessage>
    ) : null;
  }
  if (part.type === 'reasoning') {
    return (
      <ChatPartEvent
        key={key}
        kind="reasoning"
        name="reasoning"
        preview={part.text}
        status={part.state}
      />
    );
  }
  if (part.type === 'file') {
    return (
      <ChatPartEvent
        key={key}
        kind="file"
        name={part.filename ?? 'attachment'}
        preview={part.url}
        status={part.mediaType}
      />
    );
  }
  if (part.type === 'dynamic-tool') {
    const preview =
      part.state === 'output-available'
        ? JSON.stringify(part.output)
        : part.state === 'output-error'
          ? (part.errorText ?? 'Tool failed.')
          : JSON.stringify(part.input);
    return (
      <ChatPartEvent
        key={key}
        kind="tool"
        name={part.toolName}
        preview={preview}
        status={part.state}
      />
    );
  }
  return (
    <ChatPartEvent
      key={key}
      kind="data"
      name={part.type.slice(5)}
      preview={JSON.stringify(part.data)}
    />
  );
}

export function ChatPartEvent({
  kind,
  name,
  preview,
  status,
}: {
  kind: string;
  name: string;
  preview?: string;
  status?: string;
}) {
  return (
    <div className="chat-part-event">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 font-mono text-[9.5px] font-semibold uppercase text-primary">
          {kind}
        </span>
        <span
          className="min-w-0 truncate font-mono text-[11px] text-ink"
          title={name}
        >
          {name}
        </span>
        {status ? (
          <span className="shrink-0 font-mono text-[10px] text-muted">
            {status}
          </span>
        ) : null}
      </div>
      {preview ? (
        <OperationalValue
          className="mt-1"
          label={`${name} ${kind} details`}
          preview={preview.replace(/\s+/g, ' ').trim()}
          previewClassName="truncate font-mono text-[10.5px] leading-4 text-muted"
          value={preview}
        />
      ) : null}
    </div>
  );
}
