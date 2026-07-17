import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { representativeReportDeckFixture } from '../shared/report-deck-fixtures';
import { REPORT_DECK_CONTROLLER_SOURCE } from './lib/report-deck-controller';
import { renderReportDeckHtml } from './lib/report-deck-html';
import { renderReportHtml } from './lib/report-html';
import {
  listReports,
  pruneReports,
  reportsRoot,
  resolveReportFilePath,
  writeReport,
} from './modules/reports';
import { createApp } from './server/create-app';
import { REPORT_DECK_CONTROLLER_HASH } from './server/routes/reports';
import { runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('reports', () => {
  it('writes escaped self-contained HTML and lists the report record', async () => {
    const paths = runtimePaths(await tempDir());
    const html = renderReportHtml({
      eyebrow: 'PR <overview>',
      title: 'Review <script>alert(1)</script>',
      summary: 'Summary with <b>markup</b> & quotes "here".',
      sections: [
        {
          title: 'Findings',
          items: [{ label: '<path>', value: 'Use <safe> output.' }],
        },
      ],
      generatedAt: '2026-07-05T12:00:00.000Z',
    });
    const report = await writeReport(
      {
        kind: 'pr-review',
        title: 'Review <script>alert(1)</script>',
        html,
        repoId: 'neondeck',
        sourceRef: 'pandemicsyn/neondeck#123',
        summary: { summary: 'Escaped report' },
        createdBy: 'test-run',
        createdAt: '2026-07-05T12:00:00.000Z',
      },
      paths,
    );

    const file = await readFile(
      resolveReportFilePath(paths, report.htmlPath),
      'utf8',
    );
    expect(file).toContain('Review &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(file).toContain(
      'Summary with &lt;b&gt;markup&lt;/b&gt; &amp; quotes &quot;here&quot;.',
    );
    expect(file).not.toContain('<script>alert(1)</script>');
    await expect(listReports(paths)).resolves.toMatchObject([
      {
        id: report.id,
        kind: 'pr-review',
        title: 'Review <script>alert(1)</script>',
        repoId: 'neondeck',
        sourceRef: 'pandemicsyn/neondeck#123',
        summary: { summary: 'Escaped report' },
        createdBy: 'test-run',
      },
    ]);
  });

  it('excludes first-class report kinds before applying the list limit', async () => {
    const paths = runtimePaths(await tempDir());
    await writeReport(
      reportInput('hygiene', 'linked report', '2026-07-05T12:00:00.000Z'),
      paths,
    );
    await writeReport(
      reportInput('pr-review', 'review report', '2026-07-05T13:00:00.000Z'),
      paths,
    );

    await expect(
      listReports(paths, { excludeKind: 'pr-review', limit: 1 }),
    ).resolves.toMatchObject([{ kind: 'hygiene', title: 'linked report' }]);
  });

  it('prunes reports by kind limit and age with matching files', async () => {
    const paths = runtimePaths(await tempDir());
    const first = await writeReport(
      reportInput('ci-fix', 'first', '2026-07-01T00:00:00.000Z'),
      paths,
    );
    const second = await writeReport(
      reportInput('ci-fix', 'second', '2026-07-02T00:00:00.000Z'),
      paths,
    );

    await expect(
      pruneReports(paths, { kind: 'ci-fix', maxPerKind: 1 }),
    ).resolves.toEqual({ deleted: 1 });
    expect(existsSync(resolveReportFilePath(paths, first.htmlPath))).toBe(
      false,
    );
    expect(existsSync(resolveReportFilePath(paths, second.htmlPath))).toBe(
      true,
    );
    await expect(listReports(paths, { kind: 'ci-fix' })).resolves.toMatchObject(
      [{ id: second.id, title: 'second' }],
    );

    await expect(
      pruneReports(paths, {
        maxAgeDays: 1,
        now: new Date('2026-07-05T00:00:00.000Z'),
      }),
    ).resolves.toEqual({ deleted: 1 });
    expect(existsSync(resolveReportFilePath(paths, second.htmlPath))).toBe(
      false,
    );
    await expect(listReports(paths)).resolves.toEqual([]);
  });

  it('does not prune the report being written when createdAt is older than retention', async () => {
    const paths = runtimePaths(await tempDir());
    const report = await writeReport(
      reportInput(
        'hygiene',
        'old generated report',
        '2025-01-01T00:00:00.000Z',
      ),
      paths,
    );

    expect(existsSync(resolveReportFilePath(paths, report.htmlPath))).toBe(
      true,
    );
    await expect(
      listReports(paths, { kind: 'hygiene' }),
    ).resolves.toMatchObject([
      { id: report.id, title: 'old generated report' },
    ]);
  });

  it('cleans up the report artifact when the database insert fails', async () => {
    const paths = runtimePaths(await tempDir());
    await listReports(paths);
    const database = new DatabaseSync(paths.neondeckDatabase);
    try {
      database.exec('DROP TABLE reports;');
    } finally {
      database.close();
    }

    await expect(
      writeReport(
        reportInput('cleanup', 'failed insert', '2026-07-05T00:00:00.000Z'),
        paths,
      ),
    ).rejects.toThrow(/reports/);
    await expect(
      readdir(resolveReportFilePath(paths, 'cleanup')),
    ).resolves.toEqual([]);
  });

  it('serves report listings and HTML through local routes', async () => {
    const paths = runtimePaths(await tempDir());
    const report = await writeReport(
      reportInput('hygiene', 'Weekly hygiene', '2026-07-05T00:00:00.000Z'),
      paths,
    );
    const app = await createApp({
      paths,
      scheduler: false,
      staticRoot: join(paths.home, 'missing-static'),
    });

    const listResponse = await app.request('http://localhost/api/reports', {
      headers: { host: 'localhost' },
    });
    const listBody = (await listResponse.json()) as {
      ok: boolean;
      items: Array<{ id: string }>;
    };
    expect(listResponse.status).toBe(200);
    expect(listBody).toMatchObject({
      ok: true,
      items: [{ id: report.id }],
    });

    const readResponse = await app.request(
      `http://localhost/api/reports/${report.id}`,
      { headers: { host: 'localhost' } },
    );
    const readBody = (await readResponse.json()) as {
      ok: boolean;
      item: { id: string } | null;
    };
    expect(readResponse.status).toBe(200);
    expect(readBody).toMatchObject({
      ok: true,
      item: { id: report.id },
    });

    const missingResponse = await app.request(
      'http://localhost/api/reports/missing',
      { headers: { host: 'localhost' } },
    );
    expect(missingResponse.status).toBe(404);

    const htmlResponse = await app.request(
      `http://localhost/reports/${report.id}`,
      { headers: { host: 'localhost' } },
    );
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get('content-type')).toContain('text/html');
    await expect(htmlResponse.text()).resolves.toContain('Weekly hygiene');

    const blockedResponse = await app.request(
      `http://example.com/api/reports/${report.id}`,
      { headers: { host: 'example.com' } },
    );
    expect(blockedResponse.status).toBe(404);
  });

  it('serves standalone decks with an exact controller CSP hash', async () => {
    const paths = runtimePaths(await tempDir());
    const html = renderReportDeckHtml(representativeReportDeckFixture);
    const report = await writeReport(
      {
        kind: 'pr-review',
        title: representativeReportDeckFixture.title,
        html,
        summary: { deck: representativeReportDeckFixture },
        createdBy: 'test',
        createdAt: representativeReportDeckFixture.generatedAt,
      },
      paths,
    );
    const app = await createApp({
      paths,
      scheduler: false,
      staticRoot: join(paths.home, 'missing-static'),
    });

    const response = await app.request(
      `http://localhost/reports/${report.id}`,
      { headers: { host: 'localhost' } },
    );
    const servedHtml = await response.text();
    const expectedHash = createHash('sha256')
      .update(REPORT_DECK_CONTROLLER_SOURCE)
      .digest('base64');

    expect(response.status).toBe(200);
    expect(REPORT_DECK_CONTROLLER_HASH).toBe(expectedHash);
    expect(response.headers.get('content-security-policy')).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${expectedHash}'`,
    );
    expect(servedHtml).toContain(
      `<script>${REPORT_DECK_CONTROLLER_SOURCE}</script>`,
    );
  });

  it('keeps report paths under the runtime reports root', async () => {
    const paths = runtimePaths(await tempDir());
    expect(resolveReportFilePath(paths, 'kind/id.html')).toContain(
      reportsRoot(paths),
    );
    expect(() => resolveReportFilePath(paths, '../escape.html')).toThrow(
      /escapes/,
    );
  });
});

function reportInput(kind: string, title: string, createdAt: string) {
  return {
    kind,
    title,
    html: renderReportHtml({
      title,
      summary: `${title} summary`,
      generatedAt: createdAt,
    }),
    summary: { summary: `${title} summary` },
    createdBy: 'test',
    createdAt,
  };
}

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-reports-'));
  tempRoots.push(path);
  return path;
}
