import * as v from 'valibot';

export const channelSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
);

const channelRouteSchema = v.object({
  channel: channelSchema,
});

const githubWebhookPathSchema = v.pipe(
  v.string(),
  v.regex(/^\/channels\/[^/]+\/webhooks\/github$/),
);

const webSocketPathSchema = v.pipe(
  v.string(),
  v.regex(/^\/channels\/[^/]+\/ws$/),
);

// Both routes are `/channels/<channel>/<suffix>` with an identical channel
// route schema — this is the one parse implementation both
// `parseGithubWebhookRoute` and `parseWebSocketRoute` delegate to,
// parameterized only by the path pattern.
function parseChannelRoute(
  pathSchema: v.GenericSchema<string>,
  pathname: string,
): v.InferOutput<typeof channelRouteSchema> | null {
  if (!v.safeParse(pathSchema, pathname).success) return null;

  const encodedChannel = pathname.split('/')[2];
  if (!encodedChannel) return null;

  try {
    return v.parse(channelRouteSchema, {
      channel: decodeURIComponent(encodedChannel),
    });
  } catch {
    return null;
  }
}

export function parseGithubWebhookRoute(
  pathname: string,
): v.InferOutput<typeof channelRouteSchema> | null {
  return parseChannelRoute(githubWebhookPathSchema, pathname);
}

export function parseWebSocketRoute(
  pathname: string,
): v.InferOutput<typeof channelRouteSchema> | null {
  return parseChannelRoute(webSocketPathSchema, pathname);
}
