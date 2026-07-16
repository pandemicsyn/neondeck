import { z } from "zod";

export const channelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

const githubWebhookPathSchema = z
  .string()
  .regex(/^\/channels\/[^/]+\/webhooks\/github$/);

const githubWebhookRouteSchema = z.object({
  channel: channelSchema,
});

export function parseGithubWebhookRoute(
  pathname: string,
): z.infer<typeof githubWebhookRouteSchema> | null {
  if (!githubWebhookPathSchema.safeParse(pathname).success) return null;

  const encodedChannel = pathname.split("/")[2];
  if (!encodedChannel) return null;

  try {
    return githubWebhookRouteSchema.parse({
      channel: decodeURIComponent(encodedChannel),
    });
  } catch {
    return null;
  }
}
