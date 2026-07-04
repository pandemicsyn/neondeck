import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../runtime-home';
import { createApp } from './create-app';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('production static assets', () => {
  it('serves PWA manifest and icons before the SPA fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neondeck-static-'));
    tempRoots.push(root);
    const staticRoot = join(root, 'web-dist');
    await mkdir(join(staticRoot, 'icons'), { recursive: true });
    await writeFile(
      join(staticRoot, 'manifest.webmanifest'),
      '{"name":"Neondeck"}\n',
      'utf8',
    );
    await writeFile(join(staticRoot, 'icons', 'icon.svg'), '<svg />\n', 'utf8');
    await writeFile(
      join(staticRoot, 'index.html'),
      '<main>app</main>\n',
      'utf8',
    );

    const app = await createApp({
      paths: runtimePaths(join(root, 'home')),
      staticRoot,
      scheduler: false,
    });

    const manifest = await app.request(
      'http://localhost/manifest.webmanifest',
      {
        headers: { host: 'localhost' },
      },
    );
    const icon = await app.request('http://localhost/icons/icon.svg', {
      headers: { host: 'localhost' },
    });

    expect(await manifest.text()).toBe('{"name":"Neondeck"}\n');
    expect(await icon.text()).toBe('<svg />\n');
  });
});
