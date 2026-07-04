import type { JsonValue } from '@flue/runtime';
import { readChatSession, type ChatSessionRecord } from '../../sessions';
import { listMemories, type MemoryRecord } from '../../memory';
import {
  parseAppConfig,
  readRuntimeJson,
  resolveLearningConfig,
  type RuntimePaths,
} from '../../../runtime-home';
import type { LearningReviewKind } from './schemas';
import { errorMessage, truncate } from './store';

export async function readSessionForReview(
  sessionId: string,
  paths: RuntimePaths,
) {
  const result = await readChatSession(
    {
      id: sessionId,
      reason: 'conversation-learning-review',
      surface: 'learning',
    },
    paths,
  );
  if (!result.ok || !('session' in result)) {
    throw new Error(`Session ${sessionId} was not found.`);
  }
  return result.session as ChatSessionRecord;
}

export function learningPrompt(
  kind: LearningReviewKind,
  inputSummary: JsonValue,
  mode: string,
) {
  return [
    `Review this bounded Neondeck ${kind} evidence for durable learning.`,
    `Memory policy mode: ${mode}.`,
    'Return high-signal memoryActions and skillPatches only. Return empty arrays when no durable update is justified.',
    'Use memory for durable facts/preferences; use skillPatches for repeatable procedural guidance.',
    'Do not include secrets, raw transcript excerpts, raw diffs, raw logs, or temporary task state.',
    'Evidence JSON:',
    JSON.stringify(inputSummary, null, 2),
  ].join('\n\n');
}

export async function readLearningConfig(paths: RuntimePaths): Promise<
  | {
      ok: true;
      config: ReturnType<typeof resolveLearningConfig>;
    }
  | {
      ok: false;
      message: string;
    }
> {
  try {
    return {
      ok: true,
      config: resolveLearningConfig(
        await readRuntimeJson(paths.config, parseAppConfig),
      ),
    };
  } catch (error) {
    return {
      ok: false,
      message: `Learning config is invalid; model-backed learning is blocked. ${errorMessage(error)}`,
    };
  }
}

export async function listActiveLearningMemories(paths: RuntimePaths) {
  const scopes = await Promise.all([
    listMemories({ status: 'active', scope: 'user' }, paths),
    listMemories({ status: 'active', scope: 'local' }, paths),
    listMemories({ status: 'active', scope: 'project' }, paths),
  ]);
  return scopes.flatMap((scope) => scope.memories) as MemoryRecord[];
}

export async function listConversationLearningMemories(
  session: ChatSessionRecord,
  paths: RuntimePaths,
) {
  const memories = await listActiveLearningMemories(paths);
  const contextIds = new Set(session.contextMemoryIds);
  if (contextIds.size > 0) {
    return memories.filter((memory) => contextIds.has(memory.id));
  }

  return memories.filter((memory) => {
    if (memory.scope === 'user' || memory.scope === 'local') return true;
    return memory.repoId === null || memory.repoId === session.linkedRepoId;
  });
}

export function conversationProjectRepoIds(
  session: ChatSessionRecord,
  memories: MemoryRecord[],
) {
  const repoIds = projectRepoIdsFromMemories(memories);
  if (session.linkedRepoId) repoIds.push(session.linkedRepoId);
  return uniqueRepoIds(repoIds);
}

export function projectRepoIdsFromMemories(memories: MemoryRecord[]) {
  return uniqueRepoIds([
    null,
    ...memories
      .filter((memory) => memory.scope === 'project')
      .map((memory) => memory.repoId),
  ]);
}

export function uniqueRepoIds(repoIds: Array<string | null>) {
  return Array.from(new Set(repoIds));
}

export function summarizeMemories(memories: unknown[], limit = 80) {
  return memories.slice(0, limit).map((memory) => {
    const item = memory as {
      id?: string;
      scope?: string;
      key?: string;
      value?: unknown;
      repoId?: string | null;
      useCount?: number;
      updatedAt?: string;
    };
    return {
      id: item.id,
      scope: item.scope,
      key: item.key,
      value: truncate(
        typeof item.value === 'string'
          ? item.value
          : JSON.stringify(item.value),
        500,
      ),
      repoId: item.repoId ?? null,
      useCount: item.useCount ?? 0,
      updatedAt: item.updatedAt,
    };
  });
}
