import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ExecutionApproval } from '../../../api';
import { ExecutionApprovalRow } from './setup-rows';

describe('ExecutionApprovalRow', () => {
  it('names each permission decision with its scope and command context', () => {
    const approval: ExecutionApproval = {
      id: 'approval-1',
      command: 'npm run check',
      backend: 'local',
      cwd: '/Users/syn/projects/neondeck',
      context: 'interactive',
      risk: 'safe-mutation',
      policyDecision: 'ask',
      status: 'pending',
      approvalDecision: null,
      approverSurface: null,
      sessionId: null,
      requestContext: null,
      result: null,
      exitCode: null,
      stdoutPreview: null,
      stderrPreview: null,
      error: null,
      createdAt: '2026-07-17T00:00:00.000Z',
      resolvedAt: null,
      usedAt: null,
      executedAt: null,
      updatedAt: '2026-07-17T00:00:00.000Z',
    };
    const html = renderToStaticMarkup(
      <ExecutionApprovalRow approval={approval} onRefresh={() => undefined} />,
    );

    expect(html).toContain('>Allow once</button>');
    expect(html).toContain('>Allow for session</button>');
    expect(html).toContain('>Always allow</button>');
    expect(html).toContain('>Deny</button>');
    expect(html).toContain(
      'aria-label="Allow command for this session: npm run check"',
    );
  });
});
