import * as v from 'valibot';

export const kiloModelSchema = v.pipe(
  v.string(),
  v.regex(/^kilo\/[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/),
);
