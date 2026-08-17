import * as v from 'valibot';

export const errorCodeSchema = v.picklist([
  'invalid_request',
  'not_found',
  'payload_too_large',
  'relay_unavailable',
  'unauthorized',
  'upgrade_required',
]);

export const errorResponseSchema = v.object({
  error: v.pipe(v.string(), v.minLength(1)),
  code: errorCodeSchema,
});

export function jsonError(
  status: number,
  code: v.InferOutput<typeof errorCodeSchema>,
  error: string,
  headers?: HeadersInit,
): Response {
  return Response.json(v.parse(errorResponseSchema, { error, code }), {
    status,
    headers,
  });
}
