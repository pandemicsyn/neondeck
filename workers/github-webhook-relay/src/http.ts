import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'invalid_request',
  'not_found',
  'payload_too_large',
  'relay_unavailable',
  'unauthorized',
  'upgrade_required',
]);

export const errorResponseSchema = z.object({
  error: z.string().min(1),
  code: errorCodeSchema,
});

export function jsonError(
  status: number,
  code: z.infer<typeof errorCodeSchema>,
  error: string,
  headers?: HeadersInit,
): Response {
  return Response.json(errorResponseSchema.parse({ error, code }), {
    status,
    headers,
  });
}
