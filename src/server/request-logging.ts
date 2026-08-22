import type { FlueObservation } from '@flue/runtime';
import type { MiddlewareHandler } from 'hono';
import * as v from 'valibot';
import { isJsonObject, isJsonString, type JsonValue } from './http';

export type ServerLogLevel = 'error' | 'info' | 'warn';

type ResponseDiagnostics = {
  action?: string;
  message?: string;
  errors?: string[];
  requires?: string[];
};

type ServerLogWriter = (level: ServerLogLevel, message: string) => void;

const serializedFlueErrorIdentitySchema = v.object({
  name: v.optional(v.string()),
  type: v.optional(v.string()),
});

export function logApiRequests(
  options: {
    logSuccessfulReads?: boolean;
    now?: () => number;
    slowRequestMs?: number;
    write?: ServerLogWriter;
  } = {},
): MiddlewareHandler {
  const logSuccessfulReads = options.logSuccessfulReads ?? false;
  const now = options.now ?? Date.now;
  const slowRequestMs = options.slowRequestMs ?? 1_000;
  const write = options.write ?? writeServerLog;

  return async (context, next) => {
    const startedAt = now();
    try {
      await next();
    } catch (error) {
      write(
        'error',
        formatApiRequest({
          method: context.req.method,
          path: context.req.path,
          status: 500,
          durationMs: elapsedMilliseconds(startedAt, now()),
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }

    const durationMs = elapsedMilliseconds(startedAt, now());
    const failed = context.res.status >= 400;
    const successfulRead =
      !failed && ['GET', 'HEAD'].includes(context.req.method.toUpperCase());
    if (successfulRead && !logSuccessfulReads && durationMs < slowRequestMs) {
      return;
    }

    const details = await readResponseDiagnostics(context.res, failed);
    write(
      failed ? (context.res.status >= 500 ? 'error' : 'warn') : 'info',
      formatApiRequest({
        method: context.req.method,
        path: context.req.path,
        status: context.res.status,
        durationMs,
        ...details,
      }),
    );
  };
}

export function formatApiRequest(input: {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  action?: string;
  message?: string;
  errors?: string[];
  requires?: string[];
}) {
  const detailLines = [
    input.action ? `  action    ${safeLogValue(input.action)}` : null,
    input.message ? `  message   ${safeLogValue(input.message)}` : null,
    ...(input.errors ?? []).map(
      (error) => `  error     ${safeLogValue(error)}`,
    ),
    input.requires?.length
      ? `  requires  ${safeLogValue(input.requires.join(', '))}`
      : null,
  ].filter((line): line is string => Boolean(line));
  return [
    `[neondeck] HTTP ${safeLogToken(input.method).toUpperCase()} ${safeLogValue(input.path)} ${input.status} ${input.durationMs}ms`,
    ...detailLines,
  ].join('\n');
}

export function logFlueActivity(
  event: FlueObservation,
  write: ServerLogWriter = writeServerLog,
) {
  const entry = formatFlueActivity(event);
  if (entry) write(entry.level, entry.message);
}

export function formatFlueActivity(
  event: FlueObservation,
): { level: ServerLogLevel; message: string } | null {
  const fields = [
    event.agentName ? `agent=${safeLogToken(event.agentName)}` : null,
    event.submissionId
      ? `submission=${safeLogToken(event.submissionId)}`
      : null,
  ];

  switch (event.type) {
    case 'submission_queued':
      return activityEntry('info', 'submission queued', [
        ...fields,
        `kind=${safeLogToken(event.kind)}`,
      ]);
    case 'submission_running':
      return activityEntry('info', 'submission running', [
        ...fields,
        `attempt=${event.attemptCount}/${event.maxAttempts}`,
      ]);
    case 'submission_recovery':
      return activityEntry('warn', 'submission recovery', [
        ...fields,
        `operation=${safeLogToken(event.operation)}`,
        `outcome=${safeLogToken(event.outcome)}`,
      ]);
    case 'submission_settled':
      return activityEntry(
        event.outcome === 'completed' ? 'info' : 'warn',
        'submission settled',
        [
          ...fields,
          `outcome=${safeLogToken(event.outcome)}`,
          ...errorTypeField(event.error),
        ],
      );
    case 'operation': {
      if (!event.isError) return null;
      const serializedError = v.safeParse(
        serializedFlueErrorIdentitySchema,
        event.error,
      );
      const errorIdentity =
        event.error instanceof Error
          ? { name: event.error.name }
          : serializedError.success
            ? serializedError.output
            : undefined;
      return activityEntry('warn', 'operation failed', [
        ...fields,
        `operation=${safeLogToken(event.operationKind)}`,
        `duration=${Math.max(0, Math.round(event.durationMs))}ms`,
        ...errorTypeField(errorIdentity),
      ]);
    }
    default:
      return null;
  }
}

async function readResponseDiagnostics(
  response: Response,
  includeFailureDetails: boolean,
) {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('json')) return {};
  try {
    // SAFETY: JSON response decoding produces JSON-compatible values.
    const data = (await response.clone().json()) as JsonValue;
    if (!isJsonObject(data)) return {};
    const details: ResponseDiagnostics = {};
    if (isJsonString(data.action)) details.action = data.action;
    if (includeFailureDetails && isJsonString(data.message)) {
      details.message = data.message;
    }
    const errors = stringArray(data.errors);
    if (includeFailureDetails && errors.length) details.errors = errors;
    const requires = stringArray(data.requires);
    if (includeFailureDetails && requires.length) details.requires = requires;
    return details;
  } catch {
    return {};
  }
}

function activityEntry(
  level: ServerLogLevel,
  label: string,
  fields: Array<string | null>,
) {
  const details = fields.filter(Boolean).join(' ');
  return {
    level,
    message: `[neondeck] ACTIVITY ${label}${details ? ` ${details}` : ''}`,
  };
}

function errorTypeField(value: { name?: string; type?: string } | undefined) {
  if (!value) return [];
  const type = value.type ?? value.name ?? null;
  return type ? [`error=${safeLogToken(type)}`] : [];
}

function stringArray(value: JsonValue | undefined) {
  return Array.isArray(value)
    ? value.filter((item): item is string => isJsonString(item))
    : [];
}

function safeLogValue(value: string) {
  return value.replace(/\p{Cc}+/gu, ' ').slice(0, 800);
}

function safeLogToken(value: string) {
  return value.replace(/[^a-zA-Z0-9._:/#-]+/g, '_').slice(0, 160);
}

function elapsedMilliseconds(startedAt: number, finishedAt: number) {
  return Math.max(0, Math.round(finishedAt - startedAt));
}

function writeServerLog(level: ServerLogLevel, message: string) {
  if (level === 'error') {
    console.error(message);
  } else if (level === 'warn') {
    console.warn(message);
  } else {
    console.info(message);
  }
}
