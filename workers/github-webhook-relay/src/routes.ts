import * as v from 'valibot';

export const channelSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
);

const githubWebhookPathSchema = v.pipe(
  v.string(),
  v.regex(/^\/channels\/[^/]+\/webhooks\/github$/),
);

const githubWebhookRouteSchema = v.object({
  channel: channelSchema,
});

const webSocketPathSchema = v.pipe(
  v.string(),
  v.regex(/^\/channels\/[^/]+\/ws$/),
);

const webSocketRouteSchema = v.object({
  channel: channelSchema,
});

export function parseGithubWebhookRoute(
  pathname: string,
): v.InferOutput<typeof githubWebhookRouteSchema> | null {
  if (!v.safeParse(githubWebhookPathSchema, pathname).success) return null;

  const encodedChannel = pathname.split('/')[2];
  if (!encodedChannel) return null;

  try {
    return v.parse(githubWebhookRouteSchema, {
      channel: decodeURIComponent(encodedChannel),
    });
  } catch {
    return null;
  }
}

export function parseWebSocketRoute(
  pathname: string,
): v.InferOutput<typeof webSocketRouteSchema> | null {
  if (!v.safeParse(webSocketPathSchema, pathname).success) return null;

  const encodedChannel = pathname.split('/')[2];
  if (!encodedChannel) return null;

  try {
    return v.parse(webSocketRouteSchema, {
      channel: decodeURIComponent(encodedChannel),
    });
  } catch {
    return null;
  }
}
