import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  addMcpServer,
  completeMcpOAuthCallback,
  getMcpRegistry,
  listMcpApprovals,
  listMcpAudit,
  logoutMcpOAuthServer,
  readPublicMcpOAuthLogin,
  removeMcpServer,
  resolveMcpApprovalWithPaths,
  setMcpServerEnabled,
  startMcpOAuthLogin,
  updateMcpServer,
} from '../../domains/mcp';
import type { RuntimePaths } from '../../runtime-home';
import { queryNumber, safeJsonBody, safeJsonObject } from '../http';

export function createMcpRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/servers', async (c) => {
    return c.json({
      ok: true,
      action: 'mcp_servers_list',
      changed: false,
      message: 'Read MCP server statuses.',
      servers: await getMcpRegistry(paths).status(),
    });
  });

  routes.post('/servers', async (c) => {
    const result = await addMcpServer(await safeJsonBody(c), paths);
    if (result.ok) {
      const id = readIdFromResultData(result.data);
      await getMcpRegistry(paths).refresh(id);
    }
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.patch('/servers/:id', async (c) => {
    const id = c.req.param('id');
    const result = await updateMcpServer(
      { ...(await safeJsonObject(c)), id },
      paths,
    );
    if (result.ok) await getMcpRegistry(paths).refresh(id);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.delete('/servers/:id', async (c) => {
    const body = await safeJsonObject(c);
    const result = await removeMcpServer(
      {
        ...body,
        id: c.req.param('id'),
        confirm: body.confirm === true || c.req.query('confirm') === 'true',
      },
      paths,
    );
    if (result.ok) await getMcpRegistry(paths).refresh();
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/servers/:id/enable', async (c) => {
    const id = c.req.param('id');
    const result = await setMcpServerEnabled({ id }, true, paths);
    if (result.ok) await getMcpRegistry(paths).refresh(id);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/servers/:id/disable', async (c) => {
    const id = c.req.param('id');
    const result = await setMcpServerEnabled({ id }, false, paths);
    if (result.ok) await getMcpRegistry(paths).refresh(id);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/servers/:id/tools', async (c) => {
    return c.json({
      ok: true,
      action: 'mcp_tools_list',
      changed: false,
      message: 'Read cached MCP tools.',
      tools: await getMcpRegistry(paths).listTools(c.req.param('id')),
    });
  });

  routes.post('/servers/:id/refresh', async (c) => {
    const id = c.req.param('id');
    await getMcpRegistry(paths).refresh(id);
    return c.json({
      ok: true,
      action: 'mcp_server_refresh',
      changed: false,
      message: `Refreshed MCP server "${id}".`,
    });
  });

  routes.post('/servers/:id/login', async (c) => {
    const body = await safeJsonObject(c);
    const redirectUrl =
      typeof body.redirectUrl === 'string'
        ? body.redirectUrl
        : `${requestOrigin(c)}/api/mcp/oauth/callback`;
    const result = await startMcpOAuthLogin(
      { id: c.req.param('id'), redirectUrl },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/logins/:id', async (c) => {
    const login = await readPublicMcpOAuthLogin(c.req.param('id'), paths);
    if (!login) {
      return c.json(
        {
          ok: false,
          action: 'mcp_login_read',
          changed: false,
          message: 'MCP OAuth login was not found.',
        },
        404,
      );
    }
    return c.json({
      ok: true,
      action: 'mcp_login_read',
      changed: false,
      message: `Read MCP OAuth login "${login.id}".`,
      login,
    });
  });

  routes.get('/oauth/callback', async (c) => {
    const result = await completeMcpOAuthCallback(
      {
        state: c.req.query('state'),
        code: c.req.query('code'),
        error: c.req.query('error'),
      },
      paths,
    );
    const login =
      'login' in result && isRecord(result.login) ? result.login : null;
    const serverId =
      login && typeof login.serverId === 'string' ? login.serverId : undefined;
    if (result.ok && serverId) {
      await getMcpRegistry(paths).refresh(serverId);
    }
    return c.html(
      oauthCallbackHtml(result.ok, result.message),
      result.ok ? 200 : 400,
    );
  });

  routes.post('/servers/:id/logout', async (c) => {
    const body = await safeJsonObject(c);
    const id = c.req.param('id');
    const result = await logoutMcpOAuthServer(
      {
        id,
        confirm: body.confirm === true,
      },
      paths,
    );
    if (result.ok) await getMcpRegistry(paths).refresh(id);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/approvals', async (c) => {
    return c.json({
      ok: true,
      action: 'mcp_approvals_list',
      changed: false,
      message: 'Read MCP approvals.',
      approvals: await listMcpApprovals(paths, {
        includeResolved: c.req.query('includeResolved') === '1',
      }),
    });
  });

  routes.post('/approvals/:id/resolve', async (c) => {
    const result = await resolveMcpApprovalWithPaths(
      { ...(await safeJsonObject(c)), id: c.req.param('id') } as {
        id: string;
        decision: 'approve' | 'deny';
        approverSurface?: string;
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/audit', async (c) => {
    return c.json({
      ok: true,
      action: 'mcp_audit_list',
      changed: false,
      message: 'Read MCP audit rows.',
      audit: await listMcpAudit(paths, {
        serverId: c.req.query('serverId') || undefined,
        limit: queryNumber(c.req.query('limit')),
      }),
    });
  });

  return routes;
}

function requestOrigin(c: Context) {
  return new URL(c.req.url).origin;
}

function readIdFromResultData(data: unknown) {
  if (!isRecord(data)) return undefined;
  const id = data.id ?? data.serverId;
  if (typeof id === 'string') return id;
  const server = data.server;
  return isRecord(server) && typeof server.id === 'string'
    ? server.id
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function oauthCallbackHtml(ok: boolean, message: string) {
  const title = ok ? 'MCP login complete' : 'MCP login failed';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0a0b10;
        color: #d7f7ff;
        font: 14px/1.5 system-ui, sans-serif;
      }
      main {
        max-width: 36rem;
        border: 1px solid #ffffff1f;
        padding: 24px;
      }
      h1 {
        margin: 0 0 8px;
        color: ${ok ? '#69e6ff' : '#ff4fb8'};
        font: 600 16px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      p {
        margin: 0;
        color: #d7f7ffb3;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
