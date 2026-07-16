import { z } from 'zod';

const requestTargetSchema = z.object({
  method: z.string(),
  pathname: z.string(),
});

const healthRequestSchema = requestTargetSchema.extend({
  method: z.literal('GET'),
  pathname: z.literal('/healthz'),
});

const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal('github-webhook-relay'),
});

const errorResponseSchema = z.object({
  error: z.string().min(1),
});

export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    const target = requestTargetSchema.parse({
      method: request.method,
      pathname: url.pathname,
    });

    if (healthRequestSchema.safeParse(target).success) {
      return Response.json(
        healthResponseSchema.parse({
          ok: true,
          service: 'github-webhook-relay',
        }),
      );
    }

    return Response.json(
      errorResponseSchema.parse({ error: 'Not found.' }),
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;
