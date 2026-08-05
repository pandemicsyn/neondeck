import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { McpApproval, McpServer } from '../../../api';
import { McpApprovalRow, McpServerRow } from './runtime-rows';

describe('MCP runtime rows', () => {
  it('shows the server default separately from exact tool overrides', () => {
    const server: McpServer = {
      id: 'superhuman-mail',
      transport: 'http',
      enabled: true,
      approvalMode: 'prompt',
      toolOverrides: { send_draft: 'approve' },
      status: 'connected',
      auth: { kind: 'oauth', authorized: true, expiresAt: null },
      toolCount: 20,
      message: null,
      lastConnectedAt: '2026-08-05T00:00:00.000Z',
      lastErrorAt: null,
    };
    const html = renderToStaticMarkup(
      <McpServerRow server={server} onRefresh={() => undefined} />,
    );

    expect(html).toContain('server default');
    expect(html).toContain('value="prompt" selected="">ask every time');
    expect(html).toContain('tool overrides');
    expect(html).toContain('send_draft');
    expect(html).toContain('value="approve" selected="">allow');
    expect(html).toContain('inherit default');
    expect(html).toContain('ask for writes');
    expect(html).toContain('ask every time');
    expect(html).toContain('allow all');
  });

  it('offers once, chat, always, and deny for chat-linked requests', () => {
    const approval: McpApproval = {
      id: 'approval-1',
      serverId: 'superhuman-mail',
      toolName: 'send_draft',
      adaptedName: 'mcp__superhuman-mail__send_draft',
      argumentsHash: 'hash',
      argumentsPreview: '{"draft":"draft-1"}',
      status: 'pending',
      approvalDecision: null,
      approverSurface: null,
      sessionId: 'chat-1',
      createdAt: '2026-08-05T00:00:00.000Z',
      expiresAt: '2026-08-05T00:15:00.000Z',
      resolvedAt: null,
      usedAt: null,
      updatedAt: '2026-08-05T00:00:00.000Z',
    };
    const html = renderToStaticMarkup(
      <McpApprovalRow approval={approval} onRefresh={() => undefined} />,
    );

    expect(html).toContain('>once</button>');
    expect(html).toContain('>this chat</button>');
    expect(html).toContain('>always</button>');
    expect(html).toContain('>deny</button>');
  });
});
