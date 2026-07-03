import { randomBytes } from 'node:crypto';

import type { AppConfig, ResolvedLearningConfig } from './schemas';

export function defaultAppConfig(): AppConfig {
  return {
    version: 1,
    localApi: { token: generateLocalApiToken() },
  };
}

export function generateLocalApiToken() {
  return randomBytes(32).toString('base64url');
}

export function resolveLearningConfig(
  config?: Pick<AppConfig, 'learning'>,
): ResolvedLearningConfig {
  const learning = config?.learning ?? {};
  return {
    enabled: learning.enabled ?? true,
    memoryWriteMode: learning.memoryWriteMode ?? 'auto',
    skillWriteMode: learning.skillWriteMode ?? 'auto',
    memoryCurationEnabled: learning.memoryCurationEnabled ?? true,
    memoryCurationMode: learning.memoryCurationMode ?? 'review',
    conversationReviewTurnInterval:
      learning.conversationReviewTurnInterval ?? 10,
    memoryCurationTurnInterval: learning.memoryCurationTurnInterval ?? 200,
    prRetrospectiveThreshold: learning.prRetrospectiveThreshold ?? 5,
    notifications: learning.notifications ?? 'on',
    memoryMaxActiveItems: learning.memoryMaxActiveItems ?? 200,
    maxRecentTurns: learning.maxRecentTurns ?? 30,
    maxPrBatchItems: learning.maxPrBatchItems ?? 8,
    memoryPromptBudgetChars: learning.memoryPromptBudgetChars ?? 3500,
    userMemoryBudgetChars: learning.userMemoryBudgetChars ?? 1000,
    localMemoryBudgetChars: learning.localMemoryBudgetChars ?? 1000,
    projectMemoryBudgetChars: learning.projectMemoryBudgetChars ?? 1500,
  };
}

