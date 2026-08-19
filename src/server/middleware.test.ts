import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { requireLocalApiAccess } from './middleware';

function protectedApp(trustedOrigins: string[] = []) {
  const app = new Hono();
  app.use(
    '/api/*',
    requireLocalApiAccess({
      trustedOrigins,
    }),
  );
  app.all('/api/status', (c) => c.json({ ok: true }));
  return app;
}

describe('local API access middleware', () => {
  it('keeps external hosts closed by default', async () => {
    const response = await protectedApp().request(
      'https://neondeck.exe.xyz/api/status',
      { headers: { host: 'neondeck.exe.xyz' } },
    );

    expect(response.status).toBe(404);
  });

  it('allows reads through an exact trusted host', async () => {
    const response = await protectedApp(['https://neondeck.exe.xyz']).request(
      'https://neondeck.exe.xyz/api/status',
      {
        headers: { host: 'neondeck.exe.xyz' },
      },
    );

    expect(response.status).toBe(200);
  });

  it('allows mutations from the matching trusted browser origin', async () => {
    const response = await protectedApp(['https://neondeck.exe.xyz']).request(
      'https://neondeck.exe.xyz/api/status',
      {
        method: 'POST',
        headers: {
          host: 'neondeck.exe.xyz',
          origin: 'https://neondeck.exe.xyz',
          'sec-fetch-site': 'same-origin',
        },
      },
    );

    expect(response.status).toBe(200);
  });

  it('rejects a mismatched origin on a trusted host', async () => {
    const response = await protectedApp(['https://neondeck.exe.xyz']).request(
      'https://neondeck.exe.xyz/api/status',
      {
        method: 'POST',
        headers: {
          host: 'neondeck.exe.xyz',
          origin: 'https://attacker.example',
          'sec-fetch-site': 'same-origin',
        },
      },
    );

    expect(response.status).toBe(404);
  });

  it('rejects cross-site browser mutations even with a trusted origin header', async () => {
    const response = await protectedApp(['https://neondeck.exe.xyz']).request(
      'https://neondeck.exe.xyz/api/status',
      {
        method: 'POST',
        headers: {
          host: 'neondeck.exe.xyz',
          origin: 'https://neondeck.exe.xyz',
          'sec-fetch-site': 'cross-site',
        },
      },
    );

    expect(response.status).toBe(404);
  });

  it('accepts a trusted same-origin referer when Origin is absent', async () => {
    const response = await protectedApp(['https://neondeck.exe.xyz']).request(
      'https://neondeck.exe.xyz/api/status',
      {
        method: 'POST',
        headers: {
          host: 'neondeck.exe.xyz',
          referer: 'https://neondeck.exe.xyz/dashboard',
          'sec-fetch-site': 'same-origin',
        },
      },
    );

    expect(response.status).toBe(200);
  });

  it('requires external non-browser mutations to declare a trusted origin', async () => {
    const response = await protectedApp(['https://neondeck.exe.xyz']).request(
      'https://neondeck.exe.xyz/api/status',
      {
        method: 'POST',
        headers: { host: 'neondeck.exe.xyz' },
      },
    );

    expect(response.status).toBe(404);
  });

  it('retains loopback access without external configuration', async () => {
    const response = await protectedApp().request(
      'http://127.0.0.1:3583/api/status',
      {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3583',
          origin: 'http://127.0.0.1:3583',
        },
      },
    );

    expect(response.status).toBe(200);
  });
});
