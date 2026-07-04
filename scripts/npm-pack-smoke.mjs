import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'neondeck-pack-smoke-'));
const packDir = join(root, 'pack');
const projectDir = join(root, 'project');
const home = join(root, 'home');

try {
  ensureDir(packDir);
  const pack = run('npm', ['pack', '--pack-destination', packDir]);
  const tarballName = pack.stdout
    .trim()
    .split('\n')
    .findLast((line) => line.endsWith('.tgz'));
  if (!tarballName) throw new Error('npm pack did not produce a tarball.');

  ensureDir(projectDir);
  run('npm', ['init', '-y'], { cwd: projectDir });
  run('npm', ['install', '--ignore-scripts', join(packDir, tarballName)], {
    cwd: projectDir,
  });
  const status = run('npx', ['neondeck', '--home', home, '--json', 'status'], {
    cwd: projectDir,
  });
  const parsed = JSON.parse(status.stdout);
  if (parsed.paths?.neondeckDatabase !== join(home, 'data', 'neondeck.db')) {
    throw new Error(
      'Packed CLI did not boot against the requested runtime home.',
    );
  }
  console.log('Packed CLI smoke passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}

function ensureDir(path) {
  run('mkdir', ['-p', path]);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}
