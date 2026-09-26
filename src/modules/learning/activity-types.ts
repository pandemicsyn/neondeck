import type { JsonValue } from '@flue/runtime';

export type ActivityEventRecord = {
  id: number;
  submissionId: string | null;
  eventType: string;
  eventIndex: number | null;
  level: string | null;
  message: string;
  name: string | null;
  operationKind: string | null;
  operationId: string | null;
  agentName: string | null;
  instanceId: string | null;
  conversationId: string | null;
  durationMs: number | null;
  isError: boolean;
  summary: JsonValue | null;
  createdAt: string;
  detailUrl: string | null;
};
