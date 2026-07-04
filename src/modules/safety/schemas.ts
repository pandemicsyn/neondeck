import * as v from 'valibot';

export type SafetyClass =
  'read-only' | 'safe-mutation' | 'destructive-mutation' | 'host-execution';

export type SafetyPrimitive = 'tool' | 'action' | 'workflow' | 'route' | 'cli';

export type SafetyPolicyEntry = {
  id: string;
  primitive: SafetyPrimitive;
  title: string;
  class: SafetyClass;
  unattended: boolean;
  requiresConfirmation: boolean;
  audited: boolean;
  auditTarget: string;
  notes: string;
};

export type SafetyPolicy = {
  ok: boolean;
  action: 'safety_policy_read';
  version: number;
  summary: {
    readOnly: number;
    safeMutation: number;
    destructiveMutation: number;
    hostExecution: number;
    requiresConfirmation: number;
    unattendedAllowed: number;
    audited: number;
  };
  confirmationPolicy: string;
  hostExecutionPolicy: string;
  executionPolicy: {
    defaultBackend: string;
    enabledBackends: string[];
    supportedBackends: string[];
    approvalMode: string;
    unattended: string;
    preapprovedCommandCount: number;
    defaultLocalAccess: boolean;
    exeDevPlanned: boolean;
  };
  entries: SafetyPolicyEntry[];
  fetchedAt: string;
};

export const safetyPolicySchema = v.looseObject({
  ok: v.boolean(),
  action: v.literal('safety_policy_read'),
  version: v.number(),
  summary: v.looseObject({
    readOnly: v.number(),
    safeMutation: v.number(),
    destructiveMutation: v.number(),
    hostExecution: v.number(),
    requiresConfirmation: v.number(),
    unattendedAllowed: v.number(),
    audited: v.number(),
  }),
  entries: v.array(v.unknown()),
});
