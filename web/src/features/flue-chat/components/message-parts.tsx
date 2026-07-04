import type { ReactNode } from 'react';
import { MarkdownMessage } from '../../../components/MarkdownMessage';

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function renderMessagePart(part: unknown, key: string): ReactNode {
  const record = asRecord(part);
  const type = readString(record?.type) ?? 'part';
  if (type === 'text') {
    const text = readString(record?.text);
    return text ? <MarkdownMessage key={key}>{text}</MarkdownMessage> : null;
  }

  return (
    <ChatPartEvent
      kind={partKind(type)}
      key={key}
      name={partName(record) ?? humanizePartType(type)}
      preview={partPreview(record)}
      status={partStatus(record, type)}
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
        <span className="min-w-0 truncate font-mono text-[11px] text-ink">
          {name}
        </span>
        {status ? (
          <span className="shrink-0 font-mono text-[10px] text-muted">
            {status}
          </span>
        ) : null}
      </div>
      {preview ? (
        <code className="mt-1 block truncate font-mono text-[10.5px] leading-4 text-muted">
          {preview}
        </code>
      ) : null}
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function partKind(type: string) {
  const lower = type.toLowerCase();
  if (lower.includes('tool')) return 'tool';
  if (lower.includes('action')) return 'action';
  if (lower.includes('data')) return 'data';
  return 'event';
}

function partName(record: Record<string, unknown> | undefined) {
  if (!record) return undefined;
  return (
    readString(record.name) ??
    readString(record.toolName) ??
    readString(record.actionName) ??
    readString(record.tool) ??
    readString(record.action) ??
    readString(record.id) ??
    readString(record.toolCallId) ??
    readString(record.callId)
  );
}

function partStatus(record: Record<string, unknown> | undefined, type: string) {
  if (!record) return humanizePartType(type);
  return (
    readString(record.status) ??
    readString(record.state) ??
    readString(record.outcome) ??
    humanizePartType(type)
  );
}

function partPreview(record: Record<string, unknown> | undefined) {
  if (!record) return undefined;
  const candidates = [
    'input',
    'args',
    'arguments',
    'parameters',
    'result',
    'output',
    'error',
  ];
  for (const key of candidates) {
    if (key in record) return stringifyPreview(record[key]);
  }

  return undefined;
}

function stringifyPreview(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return trimPreview(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return trimPreview(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function trimPreview(value: string) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function humanizePartType(type: string) {
  return type.replace(/[_-]+/g, ' ');
}
