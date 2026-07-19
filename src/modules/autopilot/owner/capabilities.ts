import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { readAgentModelSelectionSync } from '../../runtime';
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
  return {
    model,
    provider,
    providerConfigHash: stableJsonHash(
      providers[provider as keyof typeof providers] ?? null,
    ),
    thinkingLevel: models.displayAssistantThinkingLevel,
    skillHash: sha256(readFileSync(ownerSkillPath, 'utf8')),
    soulHash: sha256(readFileSync(paths.soul, 'utf8')),
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
