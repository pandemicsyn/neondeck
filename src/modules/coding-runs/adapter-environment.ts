import { join } from 'node:path';
import * as v from 'valibot';
import type { CodingAdapter } from './adapters/contract.ts';
import type { LocalManifest } from './host-contract.ts';
const keySchema = v.pipe(
  v.string(),
  v.regex(/^[A-Z][A-Z0-9_]{0,99}$/),
  v.check(
    (key) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/.test(key),
  ),
);
// Limit JSON tree work independently from the adapter's provider-specific schema.
export function validateBoundedAdapterJson(value: unknown) {
  const pending = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const next = pending.pop();
    if (!next) break;
    if (++count > 10000 || next.depth > 32)
      throw new Error('Adapter JSON structure limit');
    if (next.value && typeof next.value === 'object') {
      for (const child of Object.values(next.value))
        pending.push({ value: child, depth: next.depth + 1 });
    }
  }
}
export function validateAdapterEnvironment(
  manifest: LocalManifest,
  adapter: CodingAdapter,
  base: Record<string, string>,
  env: Record<string, string>,
) {
  const rules = adapter.environmentRules ?? [];
  if (rules.length > 64 || Object.keys(env).length > 80)
    throw new Error('Adapter environment limit');
  const keys = new Set<string>();
  for (const rule of rules) {
    const key = v.parse(keySchema, rule.key);
    if (key in base || keys.has(key))
      throw new Error('Invalid adapter environment declaration');
    keys.add(key);
    const value = env[key];
    if (rule.kind === 'test-scenario') {
      if (value !== manifest.config.mockScenario)
        throw new Error('Invalid adapter test environment');
      continue;
    }
    if (value === undefined)
      throw new Error('Required adapter environment missing');
    if (rule.kind === 'literal') {
      v.parse(v.pipe(v.string(), v.maxLength(128 * 1024)), rule.value);
      if (value !== rule.value)
        throw new Error('Invalid adapter environment literal');
    } else if (rule.kind === 'private-path') {
      const path = v.parse(
        v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
        rule.path,
      );
      if (
        !/^(home|scratch)(?:\/[a-zA-Z0-9_.-]+)*$/.test(path) ||
        path
          .split('/')
          .some((part) => part === '.' || part === '..' || part === '.git') ||
        value !== join(manifest.directory, path)
      )
        throw new Error('Invalid adapter private environment path');
    } else {
      try {
        const raw: unknown = JSON.parse(value);
        validateBoundedAdapterJson(raw);
        v.parse(rule.schema, raw);
      } catch {
        throw new Error('Invalid adapter JSON environment');
      }
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (key in base) {
      if (value !== base[key])
        throw new Error('Adapter changed host environment');
    } else if (!keys.has(key))
      throw new Error('Adapter environment key is not permitted');
  }
}
