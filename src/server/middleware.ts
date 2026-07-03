import type { MiddlewareHandler } from 'hono';
import {
  bearerToken,
  localApiAuthHeader,
  localApiTokenMatches,
  localApiTokenQueryParam,
  readLocalApiToken,
} from '../local-api-auth';
import type { RuntimePaths } from '../runtime-home';

const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export const requireLocalApiAccess: MiddlewareHandler = async (c, next) => {
  const host = hostName(c.req.header('host'));
  if (host && localHosts.has(host)) {
    if (!isSafeMethod(c.req.method) && !isAllowedBrowserOrigin(c.req.raw)) {
      return c.json({ error: 'Not found' }, 404);
    }

    await next();
    return;
  }

  return c.json({ error: 'Not found' }, 404);
};

export function requireFlueRunInspectionToken(
  paths: RuntimePaths,
): MiddlewareHandler {
  return async (c, next) => {
    const expected = await readLocalApiToken(paths);
    const provided =
      c.req.header(localApiAuthHeader) ??
      bearerToken(c.req.header('authorization')) ??
      c.req.query(localApiTokenQueryParam);

    if (!localApiTokenMatches(provided, expected)) {
      return c.json({ error: 'Not found' }, 404);
    }

    await next();
  };
}

function hostName(host: string | undefined) {
  if (!host) return undefined;
  const lower = host.toLowerCase();
  if (lower.startsWith('[')) {
    return lower.slice(0, lower.indexOf(']') + 1);
  }

  return lower.split(':')[0];
}

function isSafeMethod(method: string) {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function isAllowedBrowserOrigin(request: Request) {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return false;
  }

  const origin = request.headers.get('origin');
  if (origin) return isLocalUrl(origin);

  const referer = request.headers.get('referer');
  if (referer) return isLocalUrl(referer);

  return true;
}

function isLocalUrl(value: string) {
  try {
    const url = new URL(value);
    return localHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
