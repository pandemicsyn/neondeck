import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';

export type HandoffActionResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  id?: string;
  deckUrl?: string;
  watch?: JsonValue;
  notification?: JsonValue;
  release?: JsonValue;
  review?: JsonValue;
  audit?: JsonValue;
  errors?: string[];
  requires?: string[];
};

export const handoffSourceSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
);

export const handoffNoteLevelSchema = v.optional(
  v.picklist(['info', 'ready', 'attention', 'urgent']),
  'info',
);

export const handoffNoteInputSchema = v.strictObject({
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  source: v.optional(handoffSourceSchema),
  repo: v.optional(v.pipe(v.string(), v.minLength(1))),
  pr: v.optional(v.pipe(v.string(), v.minLength(1))),
  level: handoffNoteLevelSchema,
});

export const handoffRegisterPrInputSchema = v.strictObject({
  ref: v.pipe(v.string(), v.minLength(1)),
  source: v.optional(handoffSourceSchema),
  watch: v.optional(v.boolean()),
  review: v.optional(v.boolean()),
  note: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
});

export const handoffWatchPrInputSchema = v.strictObject({
  ref: v.pipe(v.string(), v.minLength(1)),
  source: v.optional(handoffSourceSchema),
  desiredTerminalState: v.optional(v.picklist(['checks', 'merged'])),
  intervalSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60))),
});

export const handoffActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
  id: v.optional(v.string()),
  deckUrl: v.optional(v.string()),
});
