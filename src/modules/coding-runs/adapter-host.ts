import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { promisify } from 'node:util';
import { mkdir, unlink, stat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as v from 'valibot';
import {
  codingExecutableIdentitySchema,
  type CodingExecutableIdentity,
} from '../../../shared/coding-adapters.ts';
import { configSchema, type LocalManifest } from './host-contract.ts';
import { getCodingAdapter } from './adapters/registry.ts';
import { validateAdapterEnvironment } from './adapter-environment.ts';
import type { CodingAdapter, SelectedAuth } from './adapters/contract.ts';
import { atomicWrite, privateDirectory, readBounded } from './host-io.ts';
const exec = promisify(execFile);
const bounded = v.pipe(v.string(), v.maxLength(128 * 1024));
const secretsSchema = v.pipe(
  v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(16384))),
  v.maxLength(64),
);
const handoffSchema = v.strictObject({
  files: v.pipe(
    v.array(
      v.strictObject({
        path: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
        content: bounded,
      }),
    ),
    v.maxLength(8),
  ),
  secrets: secretsSchema,
});
export function manifestAdapter(manifest: LocalManifest) {
  if (
    manifest.version === 1 &&
    manifest.config.adapter &&
    manifest.config.adapter.id !== 'codex'
  )
    throw new Error('Legacy manifest provider mismatch');
  const identity = manifest.config.adapter;
  return getCodingAdapter(
    identity?.id ?? 'codex',
    identity?.contractVersion ?? 1,
  );
}
export async function executableIdentity(executable: string) {
  const canonical = await realpath(executable);
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error('CLI executable is not a file');
  return v.parse(codingExecutableIdentitySchema, {
    canonical,
    device: info.dev,
    inode: info.ino,
    size: info.size,
    modified: info.mtimeMs,
  });
}
export async function inspectCodingAdapterReadiness(
  input: unknown,
  home: string,
) {
  const config = v.parse(configSchema, input);
  try {
    const adapter = getCodingAdapter(
      config.adapter?.id ?? 'codex',
      config.adapter?.contractVersion ?? 1,
    );
    if (
      [
        adapter.capabilities.privateState,
        adapter.capabilities.nonInteractive,
        adapter.capabilities.cancellation,
      ].some((c) => c.status !== 'supported')
    )
      return {
        ready: false,
        version: null,
        reason: 'unsupported-cli-capability',
      };
    if (
      adapter.supportedPlatforms &&
      !adapter.supportedPlatforms.includes(process.platform)
    )
      return {
        ready: false,
        version: null,
        reason: 'unsupported-host-platform',
      };
    const args = v.parse(
      v.pipe(v.array(v.pipe(v.string(), v.maxLength(256))), v.maxLength(16)),
      adapter.versionArgs,
    );
    const { stdout } = await exec(config.executable, args, {
      cwd: home,
      timeout: 5000,
      maxBuffer: 4096,
      env: {
        PATH: config.path,
        HOME: home,
        XDG_CONFIG_HOME: home,
        XDG_DATA_HOME: home,
        XDG_STATE_HOME: home,
        XDG_CACHE_HOME: home,
        CODEX_HOME: home,
        LANG: 'C',
        NO_COLOR: '1',
      },
    });
    const version = v.parse(
      v.pipe(v.string(), v.maxLength(256)),
      stdout.trim(),
    );
    return adapter.acceptsVersion(version, config) &&
      (!config.adapter || config.adapter.cliVersion === version)
      ? { ready: true, version, reason: null }
      : { ready: false, version, reason: 'unsupported-cli-version' };
  } catch {
    return { ready: false, version: null, reason: 'cli-unavailable' };
  }
}
function credentialPath(
  directory: string,
  adapter: CodingAdapter,
  path: string,
) {
  if (
    !adapter.credentialPaths.includes(path) ||
    !/^home\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(path) ||
    path
      .split('/')
      .some((part) => part === '.' || part === '..' || part === '.git')
  )
    throw new Error('Invalid credential destination');
  return join(directory, path);
}
async function safeParent(directory: string, file: string) {
  const parent = dirname(file);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await realpath(parent)) !== resolve(parent))
    throw new Error('Credential parent is not canonical');
  for (let path = parent; path !== directory; path = dirname(path))
    await privateDirectory(path);
}
export async function prepareAdapterCredentials(
  manifest: LocalManifest,
  selected: SelectedAuth | undefined,
) {
  const adapter = manifestAdapter(manifest);
  let handoff: v.InferOutput<typeof handoffSchema>;
  try {
    handoff = v.parse(
      handoffSchema,
      adapter.credentials(selected, manifest.config),
    );
  } catch {
    throw new Error('Invalid selected credential handoff');
  }
  const seen = new Set<string>();
  for (const file of handoff.files) {
    const target = credentialPath(manifest.directory, adapter, file.path);
    if (seen.has(target)) throw new Error('Duplicate credential destination');
    seen.add(target);
    await safeParent(manifest.directory, target);
    await atomicWrite(target, file.content);
  }
}
export async function adapterCredentialRedactor(manifest: LocalManifest) {
  const adapter = manifestAdapter(manifest);
  const paths = v.parse(
    v.pipe(v.array(v.string()), v.maxLength(8)),
    adapter.credentialPaths,
  );
  const contents: string[] = [];
  for (const path of paths) {
    const file = credentialPath(manifest.directory, adapter, path);
    try {
      await privateDirectory(dirname(file));
      contents.push(await readBounded(file, 128 * 1024));
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw new Error('Invalid selected credential snapshot');
    }
  }
  let values: string[];
  try {
    values = v.parse(
      secretsSchema,
      adapter.credentialSecrets(contents, manifest.config),
    );
  } catch {
    throw new Error('Invalid selected credential snapshot');
  }
  const secrets = [
    ...new Set(
      values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
    ),
  ].sort((a, b) => b.length - a.length);
  return (text: string) => {
    for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
    return text;
  };
}
export async function removeAdapterCredentials(
  manifest: LocalManifest,
): Promise<'removed' | 'absent' | 'failed'> {
  try {
    const adapter = manifestAdapter(manifest);
    const paths = v.parse(
      v.pipe(v.array(v.string()), v.maxLength(8)),
      adapter.credentialPaths,
    );
    let removed = false;
    for (const path of paths) {
      const file = credentialPath(manifest.directory, adapter, path);
      try {
        await privateDirectory(dirname(file));
        await unlink(file);
        removed = true;
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error;
      }
    }
    return removed ? 'removed' : 'absent';
  } catch {
    return 'failed';
  }
}
const launchSchema = v.strictObject({
  args: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(1024 * 1024))),
    v.maxLength(128),
  ),
  env: v.record(v.pipe(v.string(), v.maxLength(100)), bounded),
});
export function adapterLaunch(manifest: LocalManifest) {
  const adapter = manifestAdapter(manifest);
  const launch = v.parse(launchSchema, adapter.launch(manifest));
  if (
    launch.args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) >
      2 * 1024 * 1024 ||
    Object.values(launch.env).reduce(
      (size, value) => size + Buffer.byteLength(value),
      0,
    ) >
      256 * 1024
  )
    throw new Error('Adapter launch descriptor limit');
  const home = join(manifest.directory, 'home');
  const base: Record<string, string> = {
    PATH: manifest.config.path,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: join(manifest.directory, 'scratch'),
    TMP: join(manifest.directory, 'scratch'),
    TEMP: join(manifest.directory, 'scratch'),
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
  };
  validateAdapterEnvironment(manifest, adapter, base, launch.env);
  return { args: launch.args, env: { ...base, ...launch.env } };
}

export function verifyAdapterWorkspace(manifest: LocalManifest) {
  const paths = v.parse(
    v.pipe(
      v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
      v.maxLength(32),
    ),
    manifestAdapter(manifest).forbiddenWorkspacePaths ?? [],
  );
  for (const path of paths) {
    if (
      !/^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(path) ||
      path
        .split('/')
        .some((part) => part === '.' || part === '..' || part === '.git')
    )
      throw new Error('Invalid adapter workspace guard');
    try {
      lstatSync(join(manifest.ownedWorktree.root, path));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        continue;
      throw new Error('Adapter workspace isolation could not be verified');
    }
    throw new Error('Workspace contains unsupported provider configuration');
  }
}

export async function assertExecutableIdentity(
  executable: string,
  expected: CodingExecutableIdentity,
) {
  if (
    JSON.stringify(await executableIdentity(executable)) !==
    JSON.stringify(v.parse(codingExecutableIdentitySchema, expected))
  )
    throw new Error('Pinned CLI executable identity changed');
}
