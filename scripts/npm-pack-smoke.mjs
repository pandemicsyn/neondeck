import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
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
  const packageRoot = join(projectDir, 'node_modules', 'neondeck');
  for (const requiredPath of [
    'dist/server.mjs',
    'dist/assets/migrations',
    'dist/skills/neon-pr-review/SKILL.md',
    'dist/skills/neon-ci-fix/SKILL.md',
    'dist/skills/neon-docs-fix/SKILL.md',
    'dist/skills/neon-issue-triage/SKILL.md',
    'web/dist/index.html',
    'bin/neondeck.mjs',
  ]) {
    if (!existsSync(join(packageRoot, requiredPath))) {
      throw new Error(`Packed app is missing ${requiredPath}.`);
    }
  }

  const cli = join(
    projectDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'neondeck.cmd' : 'neondeck',
  );
  const status = run(cli, ['--home', home, '--json', 'status'], {
    cwd: projectDir,
  });
  const parsed = JSON.parse(status.stdout);
  if (parsed.paths?.neondeckDatabase !== join(home, 'data', 'neondeck.db')) {
    throw new Error(
      'Packed CLI did not boot against the requested runtime home.',
    );
  }
  const port = await availablePort();
  await smokeServe(cli, home, port, projectDir);
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

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.close(resolve);
  });
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a local smoke-test port.');
  }
  return address.port;
}

async function smokeServe(cli, home, port, cwd) {
  const child = spawn(cli, ['--home', home, 'serve', '--port', String(port)], {
    cwd,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(`Packed serve exited before health check.\n${output}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) return;
      } catch {
        // Retry until the server binds or the deadline expires.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Packed serve did not become healthy.\n${output}`);
  } finally {
    await stopProcess(child);
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') {
    child.kill();
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill();
    }
  }
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}
