import { readFileSync } from 'node:fs';
import * as v from 'valibot';
import type { RuntimePaths } from '../../runtime-home';
import type { FactoryDetail } from '../../../shared/factory';
import { buildMemoryPromptSnapshotSync } from '../memory';
import {
  readAgentModelSelectionSync,
  runtimeSkillSessionSnapshotsSync,
} from '../runtime';
import { captureRepoCommit } from './repo-reader';
const str = v.string();
const nullable = v.nullable(str);
export const contextSchema = v.object({
  capturedAt: str,
  model: str,
  utilityModel: str,
  thinkingLevel: v.picklist([
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
  ]),
  utilityThinkingLevel: v.picklist([
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
  ]),
  soul: str,
  memory: str,
  memoryIds: v.array(str),
  skills: v.array(v.object({ name: str, instructions: str })),
  repoCommit: nullable,
  repoPath: nullable,
  repoFingerprint: nullable,
  sourceVersion: v.number(),
});
export function captureContext(current: FactoryDetail, paths: RuntimePaths) {
  const models = readAgentModelSelectionSync(paths);
  const memory = buildMemoryPromptSnapshotSync(paths, {
    repoId: current.work.repoId,
  });
  let soul = '';
  try {
    soul = readFileSync(paths.soul, 'utf8').slice(0, 12000);
  } catch {
    /* Optional SOUL. */
  }
  return v.parse(contextSchema, {
    capturedAt: new Date().toISOString(),
    model: models.displayAssistant,
    utilityModel: models.utility,
    thinkingLevel: models.displayAssistantThinkingLevel,
    utilityThinkingLevel: models.utilityThinkingLevel,
    soul,
    memory: memory.instructions.slice(0, 16000),
    memoryIds: memory.memoryIds,
    skills: runtimeSkillSessionSnapshotsSync(paths)
      .slice(0, 8)
      .map((s) => ({
        name: s.name,
        instructions: s.instructions.slice(0, 6000),
      })),
    repoCommit: captureRepoCommit(current.repoContext?.path ?? null),
    repoPath: current.repoContext?.path ?? null,
    repoFingerprint: current.repoFingerprint,
    sourceVersion: current.source.version,
  });
}
