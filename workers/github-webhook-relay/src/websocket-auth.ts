import { z } from 'zod';

const bearerTokenSchema = z
  .string()
  .min(16)
  .max(256)
  .regex(/^[\x21-\x7e]+$/);

const webSocketEnvironmentSchema = z.object({
  WS_CLIENT_SECRET: bearerTokenSchema,
});

const upgradeHeaderSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(z.literal('websocket'));

const authorizationHeaderSchema = z
  .string()
  .min(1)
  .max(263)
  .regex(/^Bearer [\x21-\x7e]+$/i)
  .transform((value) => value.slice(value.indexOf(' ') + 1))
  .pipe(bearerTokenSchema);

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
  const parsedEnvironment = webSocketEnvironmentSchema.safeParse(env);
  if (!parsedEnvironment.success) {
    return failure(
      500,
      'invalid_request',
      'WebSocket configuration is invalid.',
    );
  }

  const parsedUpgrade = upgradeHeaderSchema.safeParse(
    request.headers.get('upgrade'),
  );
  if (!parsedUpgrade.success) {
    return failure(426, 'upgrade_required', 'WebSocket upgrade is required.');
  }

  const parsedAuthorization = authorizationHeaderSchema.safeParse(
    request.headers.get('authorization'),
  );
  if (!parsedAuthorization.success) {
    return failure(401, 'unauthorized', 'WebSocket authentication failed.');
  }

  const [providedHash, expectedHash] = await Promise.all([
    hashSecret(parsedAuthorization.data),
    hashSecret(parsedEnvironment.data.WS_CLIENT_SECRET),
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
  return { ok: false, status, code, error };
}
