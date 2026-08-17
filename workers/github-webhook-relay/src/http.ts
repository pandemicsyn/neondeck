import * as v from 'valibot';

export const errorCodeSchema = v.picklist([
  'invalid_request',
  'not_found',
  'payload_too_large',
  'relay_unavailable',
  'unauthorized',
  'upgrade_required',
]);

// `code` is already statically constrained to `errorCodeSchema`'s output at
// every call site, and `error` is always a string literal or template this
// module builds itself — there is no untyped input here to validate. Build
// the object directly instead of round-tripping it through `v.parse`, whose
// only remaining job would be to throw if this designated error-response
// builder ever mis-typed its own output.
export function jsonError(
  status: number,
  code: v.InferOutput<typeof errorCodeSchema>,
  error: string,
  headers?: HeadersInit,
): Response {
  return Response.json({ error, code }, { status, headers });
}
