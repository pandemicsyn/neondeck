import type { ReactNode } from 'react';
import * as v from 'valibot';
import type { WebExternalValue } from '../../../api/schemas';
import { MarkdownMessage } from '../../../components/MarkdownMessage';
import { OperationalValue } from '../../../components/OperationalValue';

const textPartSchema = v.looseObject({
  type: v.literal('text'),
  text: v.string(),
  state: v.optional(v.picklist(['streaming', 'done'])),
});
const reasoningPartSchema = v.looseObject({
  type: v.literal('reasoning'),
  text: v.string(),
  state: v.optional(v.picklist(['streaming', 'done'])),
});
const filePartSchema = v.looseObject({
  type: v.literal('file'),
  filename: v.optional(v.string()),
  url: v.optional(v.string()),
  mediaType: v.optional(v.string()),
});
const dynamicToolPartSchema = v.looseObject({
  type: v.literal('dynamic-tool'),
  toolName: v.optional(v.string()),
  state: v.picklist(['input-available', 'output-available', 'output-error']),
  input: v.optional(v.unknown()),
  output: v.optional(v.unknown()),
  errorText: v.optional(v.string()),
});
const legacyToolResultPartSchema = v.looseObject({
  type: v.literal('tool-result'),
  name: v.optional(v.string()),
  output: v.optional(v.unknown()),
});
const dataPartSchema = v.looseObject({
  type: v.string(),
  data: v.optional(v.unknown()),
});
const typedPartSchema = v.looseObject({ type: v.string() });

export function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export function renderMessagePart(
  part: WebExternalValue,
  key: string,
): ReactNode {
  const legacyToolResult = v.safeParse(legacyToolResultPartSchema, part);
  if (legacyToolResult.success) {
    return (
      <ChatPartEvent
        key={key}
        kind="tool"
        name={legacyToolResult.output.name ?? 'tool'}
        preview={legacyToolPreview(legacyToolResult.output.output)}
      />
    );
  }
  const textPart = v.safeParse(textPartSchema, part);
  if (textPart.success) {
    return textPart.output.text ? (
      <MarkdownMessage key={key}>{textPart.output.text}</MarkdownMessage>
    ) : null;
  }
  const reasoningPart = v.safeParse(reasoningPartSchema, part);
  if (reasoningPart.success) {
    return (
      <ChatPartEvent
        key={key}
        kind="reasoning"
        name="reasoning"
        preview={reasoningPart.output.text}
        status={reasoningPart.output.state}
      />
    );
  }
  const filePart = v.safeParse(filePartSchema, part);
  if (filePart.success) {
    return (
      <ChatPartEvent
        key={key}
        kind="file"
        name={filePart.output.filename ?? 'attachment'}
        preview={filePart.output.url}
        status={filePart.output.mediaType}
      />
    );
  }
  const dynamicToolPart = v.safeParse(dynamicToolPartSchema, part);
  if (dynamicToolPart.success) {
    const tool = dynamicToolPart.output;
    const preview =
      tool.state === 'output-available'
        ? previewValue(tool.output)
        : tool.state === 'output-error'
          ? (tool.errorText ?? 'Tool failed.')
          : previewValue(tool.input);
    return (
      <ChatPartEvent
        key={key}
        kind="tool"
        name={tool.toolName ?? 'tool'}
        preview={preview}
        status={tool.state}
      />
    );
  }
  const dataPart = v.safeParse(dataPartSchema, part);
  if (dataPart.success && dataPart.output.type.startsWith('data-')) {
    return (
      <ChatPartEvent
        key={key}
        kind="data"
        name={dataPart.output.type.slice(5) || 'payload'}
        preview={previewValue(dataPart.output.data)}
      />
    );
  }
  const typedPart = v.safeParse(typedPartSchema, part);
  return (
    <ChatPartEvent
      key={key}
      kind="event"
      name={typedPart.success ? typedPart.output.type : 'invalid message part'}
      preview="Message part data is unavailable."
    />
  );
}

function previewValue(value: WebExternalValue) {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[unserializable data]';
  }
}

function legacyToolPreview(value: WebExternalValue) {
  const text = v.safeParse(v.string(), value);
  return text.success ? text.output : previewValue(value);
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
