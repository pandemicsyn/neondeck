import { redactGitText } from '../../lib/git';
import { asJsonValue } from '../../lib/action-result';
import type { JsonValue } from '@flue/runtime';
import { redactExecutionOutput } from '../execution/utils';

export const maxScheduledArtifactBytes = 1024 * 1024;
export const maxPersistedScheduledArtifactBytes = 256 * 1024;
export const maxPersistedScheduledRunResultBytes = 256 * 1024;

export function boundedContent(
  value: string,
  maximum = maxScheduledArtifactBytes,
) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maximum) return { content: value, truncated: false };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let end = maximum;
  let content = '';
  while (end > 0) {
    try {
      content = decoder.decode(buffer.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }
  return {
    content,
    truncated: true,
  };
}

export function sanitizedBoundedContent(
  value: string,
  maximum = maxScheduledArtifactBytes,
) {
  const sanitized = redactExecutionOutput(redactGitText(value));
  return {
    ...boundedContent(sanitized, maximum),
    redacted: sanitized !== value,
  };
}

export function sanitizedScheduledRunText(value: string) {
  return sanitizedBoundedContent(value, 16 * 1024).content;
}

export function sanitizedScheduledRunResult(value: unknown): JsonValue {
  const jsonValue = asJsonValue(value);
  const sanitized = sanitizeJsonValue(jsonValue, 0);
  const encoded = JSON.stringify(sanitized);
  if (
    Buffer.byteLength(encoded, 'utf8') <= maxPersistedScheduledRunResultBytes
  ) {
    return sanitized;
  }
  const redacted = encoded !== JSON.stringify(jsonValue);
  let low = 0;
  let high = maxPersistedScheduledRunResultBytes;
  let result: JsonValue = { truncated: true, redacted, preview: '' };
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate: JsonValue = {
      truncated: true,
      redacted,
      preview: boundedContent(encoded, midpoint).content,
    };
    if (
      Buffer.byteLength(JSON.stringify(candidate), 'utf8') <=
      maxPersistedScheduledRunResultBytes
    ) {
      result = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return result;
}

function sanitizeJsonValue(
  value: JsonValue,
  depth: number,
  key?: string,
): JsonValue {
  if (typeof value === 'string') {
    if (
      key &&
      safeScheduledIdentifierKeys.has(key) &&
      value.length <= 1_024 &&
      /^[A-Za-z0-9._:/@-]+$/.test(value)
    ) {
      return value;
    }
    return sanitizedBoundedContent(value, maxPersistedScheduledRunResultBytes)
      .content;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 20) return '[Truncated: scheduled result nesting limit]';
  if (Array.isArray(value)) {
    const limited = value
      .slice(0, 1_000)
      .map((item) => sanitizeJsonValue(item, depth + 1));
    if (value.length > limited.length) {
      limited.push(`[Truncated: ${value.length - limited.length} more items]`);
    }
    return limited;
  }
  const entries = Object.entries(value);
  const sanitized = Object.fromEntries(
    entries
      .slice(0, 1_000)
      .map(([key, item]) => [
        sanitizedScheduledRunText(key),
        sanitizeJsonValue(item, depth + 1, key),
      ]),
  );
  if (entries.length > 1_000) {
    sanitized.__truncatedEntries = entries.length - 1_000;
  }
  return sanitized;
}

const safeScheduledIdentifierKeys = new Set([
  'id',
  'taskId',
  'runId',
  'sessionId',
  'submissionId',
  'workspaceId',
  'providerId',
  'physicalResourceKey',
]);
