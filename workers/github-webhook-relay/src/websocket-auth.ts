import * as v from 'valibot';
import { failureResult } from './result';

const bearerTokenSchema = v.pipe(
  v.string(),
  v.minLength(16),
  v.maxLength(256),
  v.regex(/^[\x21-\x7e]+$/),
);

const webSocketEnvironmentSchema = v.object({
  WS_CLIENT_SECRET: bearerTokenSchema,
});

const upgradeHeaderSchema = v.pipe(
  v.string(),
  v.transform((value) => value.toLowerCase()),
  v.literal('websocket'),
);

const authorizationHeaderSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(263),
  v.regex(/^Bearer [\x21-\x7e]+$/i),
  v.transform((value) => value.slice(value.indexOf(' ') + 1)),
  bearerTokenSchema,
);

export type WebSocketAuthenticationResult =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 426 | 500;
      code: 'invalid_request' | 'unauthorized' | 'upgrade_required';
      error: string;
    };

export async function authenticateWebSocketRequest(
  request: Request,
  env: Env,
): Promise<WebSocketAuthenticationResult> {
  const parsedEnvironment = v.safeParse(webSocketEnvironmentSchema, env);
  if (!parsedEnvironment.success) {
    return failure(
      500,
      'invalid_request',
      'WebSocket configuration is invalid.',
    );
  }

  const parsedUpgrade = v.safeParse(
    upgradeHeaderSchema,
    request.headers.get('upgrade'),
  );
  if (!parsedUpgrade.success) {
    return failure(426, 'upgrade_required', 'WebSocket upgrade is required.');
  }

  const parsedAuthorization = v.safeParse(
    authorizationHeaderSchema,
    request.headers.get('authorization'),
  );
  if (!parsedAuthorization.success) {
    return failure(401, 'unauthorized', 'WebSocket authentication failed.');
  }

  const [providedHash, expectedHash] = await Promise.all([
    hashSecret(parsedAuthorization.output),
    hashSecret(parsedEnvironment.output.WS_CLIENT_SECRET),
  ]);
  if (!crypto.subtle.timingSafeEqual(providedHash, expectedHash)) {
    return failure(401, 'unauthorized', 'WebSocket authentication failed.');
  }

  return { ok: true };
}

async function hashSecret(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

function failure(
  status: 401 | 426 | 500,
  code: 'invalid_request' | 'unauthorized' | 'upgrade_required',
  error: string,
): Exclude<WebSocketAuthenticationResult, { ok: true }> {
  return failureResult(status, code, error);
}
