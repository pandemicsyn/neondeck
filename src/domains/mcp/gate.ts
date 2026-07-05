import { performance } from 'node:perf_hooks';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { currentFlueExecutionContext } from '../../modules/flue/execution-context';
import { stableJson, truncateText } from './format';
import { decideMcpToolPolicy } from './policy';
import { readMcpConfig } from './config';
import {
  consumeUsableMcpApproval,
  createMcpApprovalRequest,
  hashMcpArguments,
  insertMcpAudit,
} from './store';
import type { McpToolDelegate, McpToolEnvelope } from './stdio';

export type McpGateInput = {
  serverId: string;
  toolName: string;
  adaptedName: string;
  run: McpToolDelegate;
  context: {
    input: Record<string, unknown>;
    signal?: AbortSignal;
    sessionId?: string;
  };
};

export async function runMcpToolThroughGate(
  input: McpGateInput,
  paths: RuntimePaths = runtimePaths(),
): Promise<McpToolEnvelope> {
  const startedAt = performance.now();
  const config = await readMcpConfig(paths);
  const argumentsHash = hashMcpArguments(input.context.input);
  const argumentsPreview = stableJson(input.context.input);
  const policy = decideMcpToolPolicy({
    config,
    serverId: input.serverId,
    toolName: input.toolName,
  });

  if (policy === 'deny') {
    await insertMcpAudit(
      {
        serverId: input.serverId,
        toolName: input.toolName,
        adaptedName: input.adaptedName,
        argumentsHash,
        decision: 'deny',
        ok: false,
        durationMs: elapsed(startedAt),
        error: 'Tool is denied by MCP policy.',
      },
      paths,
    );
    return {
      ok: false,
      status: 'denied',
      server: input.serverId,
      tool: input.toolName,
      untrusted: true,
      message: `MCP tool "${input.toolName}" is denied by policy.`,
    };
  }

  let approvalId: string | null = null;
  if (policy === 'ask') {
    const sessionId =
      nonEmpty(input.context.sessionId) ??
      currentFlueExecutionContext()?.instanceId;
    const approval = await consumeUsableMcpApproval(
      {
        serverId: input.serverId,
        toolName: input.toolName,
        adaptedName: input.adaptedName,
        argumentsHash,
      },
      paths,
    );
    if (!approval) {
      const requested = await createMcpApprovalRequest(
        {
          serverId: input.serverId,
          toolName: input.toolName,
          adaptedName: input.adaptedName,
          argumentsHash,
          argumentsPreview,
          sessionId,
        },
        paths,
      );
      await insertMcpAudit(
        {
          serverId: input.serverId,
          toolName: input.toolName,
          adaptedName: input.adaptedName,
          argumentsHash,
          decision: 'ask',
          approvalId: requested?.id ?? null,
          ok: false,
          durationMs: elapsed(startedAt),
          resultPreview: requested?.argumentsPreview,
        },
        paths,
      );
      return {
        ok: false,
        status: 'approval-required',
        server: input.serverId,
        tool: input.toolName,
        adaptedName: input.adaptedName,
        untrusted: true,
        approvalId: requested?.id ?? '',
        argumentsHash,
        argumentsPreview: truncateText(argumentsPreview, 1000),
        message:
          'MCP tool approval is required. Ask the user to approve, then retry the same tool call with the same arguments.',
      };
    }
    approvalId = approval.id;
  }

  try {
    const result = await input.run(input.context);
    await insertMcpAudit(
      {
        serverId: input.serverId,
        toolName: input.toolName,
        adaptedName: input.adaptedName,
        argumentsHash,
        decision: policy === 'allow' ? 'allow' : 'approved',
        approvalId,
        ok: true,
        durationMs: elapsed(startedAt),
        resultPreview: result.text,
      },
      paths,
    );
    return {
      ok: true,
      status: 'ok',
      server: input.serverId,
      tool: input.toolName,
      adaptedName: input.adaptedName,
      untrusted: true,
      content: result.text,
      structuredContent: jsonValueOrNull(result.structuredContent),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await insertMcpAudit(
      {
        serverId: input.serverId,
        toolName: input.toolName,
        adaptedName: input.adaptedName,
        argumentsHash,
        decision: policy === 'allow' ? 'allow' : 'approved',
        approvalId,
        ok: false,
        durationMs: elapsed(startedAt),
        error: message,
      },
      paths,
    );
    return {
      ok: false,
      status: 'error',
      server: input.serverId,
      tool: input.toolName,
      adaptedName: input.adaptedName,
      untrusted: true,
      message,
    };
  }
}

function nonEmpty(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function elapsed(startedAt: number) {
  return Math.round(performance.now() - startedAt);
}

function jsonValueOrNull(value: unknown) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}
