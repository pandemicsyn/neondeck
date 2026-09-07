import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { writeFactoryDiagnosticPreview } from './factory-diagnostics';
import { exportFixture } from '../modules/factory-diagnostics/export-fixture.test-helper';
const homes: string[] = [];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'diagnostic-cli-'));
  homes.push(home);
  return {
    home,
    input: join(home, 'preview.json'),
    output: join(home, 'export.json'),
    bytes: JSON.stringify(exportFixture(), null, 2) + '\n',
  };
}
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
it('writes the exact reviewed bytes locally with private permissions and refuses overwrite', async () => {
  const f = await fixture();
  await writeFile(f.input, f.bytes);
  await writeFactoryDiagnosticPreview(f.input, f.output);
  expect(await readFile(f.output, 'utf8')).toBe(f.bytes);
  expect((await stat(f.output)).mode & 0o777).toBe(0o600);
  await expect(
    writeFactoryDiagnosticPreview(f.input, f.output),
  ).rejects.toThrow();
});
it('rejects unknown fields, duplicate-key hidden content, remote destinations and oversized previews', async () => {
  const f = await fixture();
  await writeFile(f.input, '{"rawLogs":"secret",' + f.bytes.slice(1));
  await expect(
    writeFactoryDiagnosticPreview(f.input, f.output),
  ).rejects.toThrow();
  await writeFile(f.input, '{"notice":"secret",' + f.bytes.slice(1));
  await expect(
    writeFactoryDiagnosticPreview(f.input, f.output),
  ).rejects.toThrow('canonical');
  await writeFile(f.input, f.bytes);
  await expect(
    writeFactoryDiagnosticPreview(f.input, 'https://example.invalid/upload'),
  ).rejects.toThrow();
  await writeFile(f.input, ' '.repeat(2_000_001));
  await expect(
    writeFactoryDiagnosticPreview(f.input, f.output),
  ).rejects.toThrow('2 MB');
});
it('formats readable doctor output with concrete next steps', async () => {
  const { formatFactoryDoctor } = await import('./factory-diagnostics');
  const { diagnoseHealth } =
    await import('../modules/factory-diagnostics/health');
  const { taskFixture, workerFixture, recordedAt } =
    await import('../modules/factory-diagnostics/fixture.test-helper');
  const text = formatFactoryDoctor(
    diagnoseHealth([taskFixture()], [workerFixture('stopped')], recordedAt),
  );
  expect(text).toContain('Factory: not-running');
  expect(text).toContain('coding: stopped');
  expect(text).toContain('Next: Inspect the draft');
  expect(text).not.toContain('"generatedAt"');
});
it('rejects a FIFO without waiting for a writer and rejects symbolic links', async () => {
  const { execFileSync } = await import('node:child_process');
  const { symlink } = await import('node:fs/promises');
  const f = await fixture();
  const fifo = join(f.home, 'preview.fifo');
  execFileSync('mkfifo', [fifo]);
  await expect(writeFactoryDiagnosticPreview(fifo, f.output)).rejects.toThrow(
    'regular file',
  );
  await writeFile(f.input, f.bytes);
  const link = join(f.home, 'preview-link.json');
  await symlink(f.input, link);
  await expect(writeFactoryDiagnosticPreview(link, f.output)).rejects.toThrow();
}, 1000);
it('explains a waiting worker fault with safe error details and degraded storage', async () => {
  const { formatFactoryDoctor } = await import('./factory-diagnostics');
  const { diagnoseHealth } =
    await import('../modules/factory-diagnostics/health');
  const { workerFixture, recordedAt } =
    await import('../modules/factory-diagnostics/fixture.test-helper');
  const worker = workerFixture();
  worker.lastError = { class: 'io', code: 'ENOSPC' };
  worker.consecutiveFailures = 2;
  worker.diagnosticsDegraded = true;
  const text = formatFactoryDoctor(diagnoseHealth([], [worker], recordedAt));
  expect(text).toContain('Factory: attention');
  expect(text).toContain('coding: waiting');
  expect(text).toContain('Consecutive failures: 2');
  expect(text).toContain('Last error: io/ENOSPC');
  expect(text).toContain('Diagnostic storage degraded');
  expect(text).toContain('Check local storage and database access.');
});
