import { timingSafeEqual } from 'node:crypto';
import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';

export const localApiAuthHeader = 'x-neondeck-api-token';
export const localApiTokenQueryParam = 'neondeckApiToken';

export async function readLocalApiToken(paths: RuntimePaths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const config = await readRuntimeJson(paths.config, parseAppConfig);
  return config.localApi?.token ?? null;
}

export function flueRunInspectionUrl(runId: string, token?: string | null) {
  const base = `/api/flue/runs/${encodeURIComponent(runId)}?meta`;
  return token
    ? `${base}&${localApiTokenQueryParam}=${encodeURIComponent(token)}`
    : base;
}

export function bearerToken(value: string | undefined) {
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

export function localApiTokenMatches(
  provided: string | null | undefined,
  expected: string | null | undefined,
) {
  if (!provided || !expected) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}
