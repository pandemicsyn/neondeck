import type { Context } from 'hono';

export async function safeJsonBody(c: Context): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

export async function safeJsonObject(
  c: Context,
): Promise<Record<string, unknown>> {
  const body = await safeJsonBody(c);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

export function boundedQueryLimit(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return undefined;
  return limit;
}

export function queryNumber(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function queryBoolean(value: string | undefined) {
  if (!value) return undefined;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return undefined;
}

export function preparedDiffHttpStatus(result: {
  ok: boolean;
  error?: { code?: string };
}) {
  if (result.ok) return 200;
  if (result.error?.code === 'PREPARED_DIFF_NOT_FOUND') return 404;
  return 400;
}
