import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
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
    'dist/neondeck-server.mjs',
    'dist/app.mjs',
    'dist/assets/migrations',
    'dist/skills/neon-pr-tour/SKILL.md',
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
  run('npm', ['run', 'setup', '--', '--home', home, '--json'], {
    cwd: packageRoot,
  });
  assertSetupHome(home);
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

function assertSetupHome(home) {
  for (const requiredPath of [
    '.env',
    'config.json',
    'mcp.json',
    'repos.json',
    'dashboard.json',
    'dashboard.schema.json',
    'SOUL.md',
    'data/neondeck.db',
    'data/flue.db',
  ]) {
    if (!existsSync(join(home, requiredPath))) {
      throw new Error(`Packed setup did not create ${requiredPath}.`);
    }
  }

  const config = readJson(join(home, 'config.json'));
  const repos = readJson(join(home, 'repos.json'));
  const mcp = readJson(join(home, 'mcp.json'));
  if (
    !Number.isInteger(config.version) ||
    config.version < 1 ||
    !/^[A-Za-z0-9_-]{32,}$/.test(config.localApi?.token ?? '')
  ) {
    throw new Error('Packed setup created an invalid config.json.');
  }
  if (!Array.isArray(repos.repos)) {
    throw new Error('Packed setup created an invalid repos.json.');
  }
  if (!mcp.servers || typeof mcp.servers !== 'object') {
    throw new Error('Packed setup created an invalid mcp.json.');
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
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
  const ingressPort = await availablePort();
  const child = spawn(cli, ['--home', home, 'serve', '--port', String(port)], {
    cwd,
    env: {
      ...process.env,
      NEONDECK_INGRESS_PORT: String(ingressPort),
      NEONDECK_INGRESS_HOST: '127.0.0.1',
      NEONDECK_PRIVATE_HOST: '127.0.0.1',
    },
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
        if (response.ok) {
          await assertRuntimeSkills(port);
          await assertIngressIsolation(ingressPort, port);
          break;
        }
      } catch {
        // Retry until the server binds or the deadline expires.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (Date.now() >= deadline)
      throw new Error(`Packed serve did not become healthy.\n${output}`);
  } finally {
    await stopProcess(child);
  }
  for (const closedPort of [port, ingressPort]) {
    try {
      await fetch(`http://127.0.0.1:${closedPort}/health`, {
        signal: AbortSignal.timeout(1000),
      });
    } catch {
      continue;
    }
    throw new Error('Packaged listener remained reachable after shutdown.');
  }
  await smokeManagedEntry(home, port, ingressPort, cwd);
  await assertBindRollback(cli, home, port, ingressPort, cwd);
}

// systemd/launchd invoke the packaged entry directly, without the CLI env loader.
async function smokeManagedEntry(home, port, ingressPort, cwd) {
  const envPath = join(home, '.env');
  const original = existsSync(envPath) ? readFileSync(envPath, 'utf8') : null;
  const env = {
    ...process.env,
    NEONDECK_HOME: home,
    NEONDECK_PORT: String(port),
    PORT: String(port),
  };
  delete env.NEONDECK_INGRESS_PORT;
  delete env.NEONDECK_INGRESS_HOST;
  delete env.NEONDECK_PRIVATE_HOST;
  writeFileSync(
    envPath,
    `${original ?? ''}\nNEONDECK_INGRESS_PORT=${ingressPort}\nNEONDECK_INGRESS_HOST=127.0.0.1\nNEONDECK_PRIVATE_HOST=::1\n`,
  );
  const entry = join(cwd, 'node_modules', 'neondeck', 'dist', 'server.mjs');
  const child = spawn(process.execPath, [entry], {
    cwd,
    env,
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
  try {
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        const privateHealth = await fetch(`http://[::1]:${port}/api/health`);
        const publicHealth = await fetch(
          `http://127.0.0.1:${ingressPort}/health`,
        );
        if (privateHealth.ok && publicHealth.ok) break;
      } catch {
        /* startup */
      }
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(
          `Direct managed entry failed runtime-home listener config.\n${output}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (
      (await fetch(`http://127.0.0.1:${ingressPort}/api/health`)).status !== 404
    )
      throw new Error('Managed public listener exposed private route');
    console.info(
      'Direct managed entry: runtime-home .env, IPv6 private health and public isolation passed.',
    );
  } finally {
    await stopProcess(child);
    if (original === null) rmSync(envPath);
    else writeFileSync(envPath, original);
  }
}

async function assertRuntimeSkills(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/runtime/status`);
  if (!response.ok) {
    throw new Error(`Packed runtime status returned HTTP ${response.status}.`);
  }
  const status = await response.json();
  const skillsCheck = status.checks?.find((check) => check.id === 'skills');
  if (skillsCheck?.ok !== true || !(status.counts?.activeSkills >= 7)) {
    throw new Error(
      `Packed runtime could not load built-in skills.\n${JSON.stringify(
        {
          skillsCheck,
          activeSkills: status.counts?.activeSkills,
        },
        null,
        2,
      )}`,
    );
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

async function assertIngressIsolation(ingressPort, privatePort) {
  const health = await fetch(`http://127.0.0.1:${ingressPort}/health`);
  if (!health.ok) throw new Error('Packed ingress health failed.');
  for (const path of [
    '/api/health',
    '/api/factory/state',
    '/api/flue/agents/factory-planner/test',
    '/agents/test',
    '/reports/test',
    '/attachments/test',
    '/assets/test.js',
    '/',
    '/factory',
  ]) {
    const response = await fetch(`http://127.0.0.1:${ingressPort}${path}`, {
      headers: { Host: 'localhost', Origin: `http://localhost:${privatePort}` },
    });
    if (response.status !== 404)
      throw new Error(
        `Packed public listener exposed ${path}: ${response.status}`,
      );
  }
  const planner = await fetch(
    `http://127.0.0.1:${privatePort}/api/flue/agents/factory-planner/unbound?view=history`,
  );
  if (planner.status !== 403)
    throw new Error('Packed planner binding route missing.');
}
async function assertBindRollback(cli, home, port, ingressPort, cwd) {
  const occupied = createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(ingressPort, '127.0.0.1', resolve);
  });
  try {
    const child = spawn(
      cli,
      ['--home', home, 'serve', '--port', String(port)],
      {
        cwd,
        stdio: 'ignore',
        env: {
          ...process.env,
          NEONDECK_INGRESS_PORT: String(ingressPort),
          NEONDECK_INGRESS_HOST: '127.0.0.1',
        },
      },
    );
    const code = await Promise.race([
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      }),
      new Promise((_, reject) =>
        setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('Packed bind failure did not terminate.'));
        }, 10000).unref(),
      ),
    ]);
    if (code === 0) throw new Error('Packed bind failure reported success.');
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
    } catch {
      return;
    }
    throw new Error('Packed bind failure left private listener reachable.');
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
}
