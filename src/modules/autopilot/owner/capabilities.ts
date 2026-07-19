import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { readAgentModelSelectionSync } from '../../runtime';
import { providerRuntimeRegistrations } from '../../repos/providers';
import {
  parseAppConfig,
  readRuntimeJsonSync,
  runtimePaths,
  type RuntimePaths,
  type ThinkingLevel,
} from '../../../runtime-home';
import { stableJsonHash } from './grounding';

const ownerSkillPath = fileURLToPath(
  new URL('../../../skills/neon-autopilot-fix/SKILL.md', import.meta.url),
);

const capabilitySchema = v.strictObject({
  model: v.pipe(v.string(), v.minLength(1)),
  provider: v.pipe(v.string(), v.minLength(1)),
  providerConfigHash: v.pipe(v.string(), v.minLength(1)),
  thinkingLevel: v.picklist([
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
  ]),
  skillHash: v.pipe(v.string(), v.minLength(1)),
  soulHash: v.pipe(v.string(), v.minLength(1)),
});

export type AutopilotOwnerCapabilitySnapshot = v.InferOutput<
  typeof capabilitySchema
>;

export function readAutopilotOwnerCapabilitySnapshot(
  paths: RuntimePaths = runtimePaths(),
): AutopilotOwnerCapabilitySnapshot {
  const models = readAgentModelSelectionSync(paths);
  const model = models.displayAssistant;
  const provider = model.includes('/')
    ? model.slice(0, model.indexOf('/'))
    : model;
  const config = readRuntimeJsonSync(paths.config, parseAppConfig);
  const providers = config.providers ?? {};
  const runtimeRegistration = providerRuntimeRegistrations(
    process.env,
    config,
  ).find((candidate) => candidate.id === provider);
  return {
    model,
    provider,
    providerConfigHash: stableJsonHash({
      configured: providers[provider as keyof typeof providers] ?? null,
      effective: runtimeRegistration
        ? sanitizeProviderRegistration(runtimeRegistration.registration)
        : null,
    }),
    thinkingLevel: models.displayAssistantThinkingLevel,
    skillHash: sha256(readFileSync(ownerSkillPath, 'utf8')),
    soulHash: sha256(readFileSync(paths.soul, 'utf8')),
  };
}

function sanitizeProviderRegistration(
  registration: ReturnType<
    typeof providerRuntimeRegistrations
  >[number]['registration'],
) {
  const { apiKey, headers, ...configuration } =
    registration as unknown as Record<string, unknown>;
  return {
    ...configuration,
    apiKeyHash: sha256(typeof apiKey === 'string' ? apiKey : ''),
    headers:
      headers && typeof headers === 'object'
        ? Object.fromEntries(
            Object.entries(headers)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([name, value]) => [name, sha256(String(value))]),
          )
        : null,
  };
}

export function parseAutopilotOwnerCapabilitySnapshot(
  value: unknown,
): AutopilotOwnerCapabilitySnapshot {
  return v.parse(capabilitySchema, value);
}

export function capabilitySnapshotHash(
  snapshot: AutopilotOwnerCapabilitySnapshot,
) {
  return stableJsonHash(snapshot);
}

export function capabilitySnapshotJson(
  snapshot: AutopilotOwnerCapabilitySnapshot,
) {
  return JSON.stringify(snapshot);
}

export function parseStoredCapabilitySnapshot(
  value: unknown,
): AutopilotOwnerCapabilitySnapshot {
  if (typeof value !== 'string') {
    throw new Error('Stored owner capability snapshot is not valid JSON.');
  }
  return parseAutopilotOwnerCapabilitySnapshot(JSON.parse(value));
}

export function ownerThinkingLevel(
  snapshot: AutopilotOwnerCapabilitySnapshot,
): ThinkingLevel {
  return snapshot.thinkingLevel;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
