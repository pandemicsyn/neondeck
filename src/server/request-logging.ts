import type { MiddlewareHandler } from 'hono';

type FailureLogLevel = 'error' | 'warn';

type FailureLogWriter = (level: FailureLogLevel, message: string) => void;

export function logFailedApiRequests(
  options: {
    now?: () => number;
    write?: FailureLogWriter;
  } = {},
): MiddlewareHandler {
  const now = options.now ?? Date.now;
  const write = options.write ?? writeFailureLog;

  return async (context, next) => {
    const startedAt = now();
    try {
      await next();
    } catch (error) {
      write(
        'error',
        formatFailedRequest({
          method: context.req.method,
          path: context.req.path,
          status: 500,
          durationMs: elapsedMilliseconds(startedAt, now()),
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }

    if (context.res.status < 400) return;
    const details = await readFailureResponse(context.res);
    write(
      context.res.status >= 500 ? 'error' : 'warn',
      formatFailedRequest({
        method: context.req.method,
        path: context.req.path,
        status: context.res.status,
        durationMs: elapsedMilliseconds(startedAt, now()),
        ...details,
      }),
    );
  };
}

export function formatFailedRequest(input: {
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
    `[neondeck] HTTP ${input.method.toUpperCase()} ${input.path} ${input.status} ${input.durationMs}ms`,
    ...detailLines,
  ].join('\n');
}

async function readFailureResponse(response: Response) {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('json')) return {};
  try {
    const data = (await response.clone().json()) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const record = data as Record<string, unknown>;
    return {
      ...(typeof record.action === 'string' ? { action: record.action } : {}),
      ...(typeof record.message === 'string'
        ? { message: record.message }
        : {}),
      ...(stringArray(record.errors).length
        ? { errors: stringArray(record.errors) }
        : {}),
      ...(stringArray(record.requires).length
        ? { requires: stringArray(record.requires) }
        : {}),
    };
  } catch {
    return {};
  }
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function safeLogValue(value: string) {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 800);
}

function elapsedMilliseconds(startedAt: number, finishedAt: number) {
  return Math.max(0, Math.round(finishedAt - startedAt));
}

function writeFailureLog(level: FailureLogLevel, message: string) {
  if (level === 'error') {
    console.error(message);
  } else {
    console.warn(message);
  }
}
