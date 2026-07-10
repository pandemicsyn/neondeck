import { type JsonValue } from '@flue/runtime';

export type NotificationLevel = 'info' | 'ready' | 'attention' | 'urgent';

export type AutomationExecutionResult = {
  outcome: 'silent' | 'updated' | 'recorded' | 'failed';
  message: string;
  result?: unknown;
  notifications?: Array<{
    level: NotificationLevel;
    title: string;
    message: string;
    source?: string;
    sourceId?: string;
    data?: unknown;
  }>;
};

export type NotificationRecord = {
  id: string;
  level: NotificationLevel;
  title: string;
  message: string;
  source: string | null;
  sourceId: string | null;
  data: JsonValue | null;
  readAt: string | null;
  resolvedAt: string | null;
  occurrenceCount: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowSummaryRecord = {
  id: string;
  workflow: string;
  runId: string | null;
  status: string;
  summary: JsonValue | null;
  createdAt: string;
  updatedAt: string;
};
