import type { MiddlewareHandler } from 'hono';
import {
  bearerToken,
  localApiAuthHeader,
  localApiTokenMatches,
  localApiTokenQueryParam,
  readLocalApiToken,
} from '../modules/runtime';
import type { RuntimePaths } from '../runtime-home';

const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export type LocalApiAccessOptions = {
  trustedOrigins?: readonly string[];
};

export function requireLocalApiAccess(
  options: LocalApiAccessOptions = {},
): MiddlewareHandler {
  const trustedOrigins = resolveTrustedOrigins(options.trustedOrigins);

  return async (c, next) => {
    const target = accessTarget(c.req.header('host'), trustedOrigins);
    if (!target) return c.json({ error: 'Not found' }, 404);

    if (!isSafeMethod(c.req.method)) {
      const allowed =
        target.kind === 'local'
          ? isAllowedLocalBrowserOrigin(c.req.raw)
          : isAllowedTrustedBrowserOrigin(c.req.raw, target.origins);
      if (!allowed) {
        return c.json({ error: 'Not found' }, 404);
      }
    }

    await next();
  };
}

export function resolveTrustedOrigins(origins: readonly string[] = []) {
  return origins.map((value) => {
    const url = new URL(value);
    return {
      origin: url.origin,
      host: url.host.toLowerCase(),
    };
  });
}

function accessTarget(
  hostHeader: string | undefined,
  trustedOrigins: ReturnType<typeof resolveTrustedOrigins>,
) {
  const host = parseRequestHost(hostHeader);
  if (!host) return null;
  if (localHosts.has(host.hostname)) return { kind: 'local' as const };

  const origins = trustedOrigins
    .filter((entry) => entry.host === host.host)
    .map((entry) => entry.origin);
  return origins.length > 0
    ? { kind: 'trusted' as const, origins: new Set(origins) }
    : null;
}

function parseRequestHost(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(`http://${value}`);
    return {
      host: url.host.toLowerCase(),
      hostname: url.hostname.toLowerCase(),
    };
  } catch {
    return null;
  }
}

function isAllowedLocalBrowserOrigin(request: Request) {
  if (!hasAllowedFetchSite(request)) return false;

  const origin = request.headers.get('origin');
  if (origin) return isLocalUrl(origin);

  const referer = request.headers.get('referer');
  if (referer) return isLocalUrl(referer);

  return true;
}

function isAllowedTrustedBrowserOrigin(
  request: Request,
  trustedOrigins: Set<string>,
) {
  if (!hasAllowedFetchSite(request)) return false;

  const origin = request.headers.get('origin');
  if (origin) return trustedOrigins.has(urlOrigin(origin));

  const referer = request.headers.get('referer');
  if (referer) return trustedOrigins.has(urlOrigin(referer));

  return false;
}

function hasAllowedFetchSite(request: Request) {
  const fetchSite = request.headers.get('sec-fetch-site');
  return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
}

function urlOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

/*
 * Raw run inspection remains separately token-protected. Trusted origins only
 * widen the app API and report surfaces mounted behind this middleware.
 */
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

function isSafeMethod(method: string) {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function isLocalUrl(value: string) {
  try {
    const url = new URL(value);
    return localHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
