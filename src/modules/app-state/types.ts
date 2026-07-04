import { type JsonValue } from '@flue/runtime';

export type NotificationLevel = 'info' | 'ready' | 'attention' | 'urgent';

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

export type JobRecord = {
  id: string;
  type: string;
  blueprint: string | null;
  enabled: boolean;
  intervalSeconds: number;
  config: JsonValue | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastOutcome: string | null;
  lastMessage: string | null;
  lastResult: JsonValue | null;
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
