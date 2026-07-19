import { defineAction, type JsonValue } from '@flue/runtime';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import { resolveAgentModelSelection } from './agent-config';
import { readEnvFiles } from './env';
import {
  isRegisteredProvider,
  resolveAnthropicProviderStatus,
  resolveKilocodeProviderStatus,
  resolveOpenAiProviderStatus,
  type RegisteredProviderId,
} from '../repos';
import {
  readGitRepoStatus,
  readRepoHealthSnapshot,
  readRepoRegistrySnapshot,
} from '../repos';
import { requiredModelProviders } from './status';
import {
  readAutopilotReadiness,
  type AutopilotReadiness,
} from './autopilot-readiness';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
  type AppConfig,
} from '../../runtime-home';

type DoctorStatus = 'ok' | 'attention';

type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorStatus;
  message: string;
  data?: JsonValue;
};

export type DevDoctorResult = {
  ok: true;
  action: 'dev_doctor_run';
  changed: false;
  status: DoctorStatus;
  message: string;
  checks: DoctorCheck[];
  autopilot: AutopilotReadiness | null;
  summary: {
    attention: number;
    repos: number;
    envMissing: string[];
    portsOpen: number;
  };
};

export type DevDoctorInput = {
  repoId?: string;
  prNumber?: number;
  mode?:
    | 'notify-only'
    | 'prepare-only'
    | 'autofix-with-approval'
    | 'autofix-push-when-safe';
};

type PackageSnapshot = {
  path: string;
  scripts: Record<string, string>;
  error?: string;
};

type EnvRequirement = {
  id: string;
  aliases?: string[];
};

const packageJsonSchema = v.object({
  scripts: v.optional(v.record(v.string(), v.string())),
});
const healthResponseSchema = v.object({
  ok: v.boolean(),
  service: v.optional(v.string()),
  home: v.optional(v.string()),
  uptimeSeconds: v.optional(v.number()),
});
const rootDir = dirname(
  fileURLToPath(new URL('../../../package.json', import.meta.url)),
);
const devDoctorOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
});
const devDoctorInputSchema = v.object({
  repoId: v.optional(v.pipe(v.string(), v.minLength(1))),
  prNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  mode: v.optional(
    v.picklist([
      'notify-only',
      'prepare-only',
      'autofix-with-approval',
      'autofix-push-when-safe',
    ]),
  ),
});

export const devDoctorRunAction = defineAction({
  name: 'neondeck_dev_doctor_run',
  description:
    'Run deterministic local development health checks for configured repos, scripts, env, ports, runtime databases, and Node version.',
  input: devDoctorInputSchema,
  output: devDoctorOutputSchema,
  async run({ input, log }) {
    log.info('Dev doctor requested');

    const result = await runDevDoctor(runtimePaths(), input);
    const payload = {
      status: result.status,
      message: result.message,
      attention: result.summary.attention,
      repos: result.summary.repos,
      envMissing: result.summary.envMissing,
    };
    if (result.status === 'attention') {
      log.warn('Dev doctor found issues', payload);
    } else {
      log.info('Dev doctor completed', payload);
    }

    return result;
  },
});

export const repoStatusListAction = defineAction({
  name: 'neondeck_repo_status_list',
  description:
    'List deterministic local git status for configured repositories without creating a workflow summary.',
  input: v.object({}),
  output: devDoctorOutputSchema,
  async run() {
    return listRepoStatus();
  },
});

export const neondeckDevDoctorActions = [devDoctorRunAction];

export async function runDevDoctor(
  paths: RuntimePaths = runtimePaths(),
  rawInput: DevDoctorInput = {},
): Promise<DevDoctorResult> {
  const input = v.parse(devDoctorInputSchema, rawInput);
  await ensureRuntimeHome(paths);
  const databases = databaseCheck(paths);
  const [repos, localEnv, rootPackage, ports, appConfig] = await Promise.all([
    readRepoHealthSnapshot(paths),
    readEnvFiles(paths),
    readPackageSnapshot(rootDir),
    checkPorts([
      { id: 'dashboard', host: '127.0.0.1', port: 5173 },
      { id: 'api', host: '127.0.0.1', port: 3583 },
    ]),
    readAppConfig(paths),
  ]);
  const repoPackages = await Promise.all(
    repos.repos.map((repo) => readPackageSnapshot(repo.path)),
  );

  const envResult = envCheck(localEnv, appConfig, repos);
  const readinessRepoId = input.repoId ?? repos.repos[0]?.id;
  const autopilot = readinessRepoId
    ? await readAutopilotReadiness(
        {
          repoId: readinessRepoId,
          prNumber: input.prNumber,
          mode: input.mode,
        },
        paths,
        {
          env: mergedEnv(localEnv),
          remoteChecks: input.prNumber !== undefined,
        },
      )
    : null;
  const checks = [
    repoHealthCheck(repos),
    packageScriptsCheck(rootPackage, repoPackages),
    nodeVersionCheck(),
    envResult.check,
    portsCheck(ports),
    await serverHealthCheck(),
    databases,
    autopilotDoctorCheck(autopilot, input.prNumber !== undefined),
  ];
  const attention = checks.filter((check) => check.status === 'attention');

  return {
    ok: true,
    action: 'dev_doctor_run',
    changed: false,
    status: attention.length > 0 ? 'attention' : 'ok',
    message:
      attention.length > 0
        ? `Dev doctor found ${attention.length} item${attention.length === 1 ? '' : 's'} needing attention.`
        : 'Dev doctor found no local issues.',
    checks,
    autopilot,
    summary: {
      attention: attention.length,
      repos: repos.count,
      envMissing: envResult.missing,
      portsOpen: ports.filter((port) => port.open).length,
    },
  };
}

export async function listRepoStatus(paths: RuntimePaths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const registry = await readRepoRegistrySnapshot(paths);
  const repos = await Promise.all(registry.repos.map(readGitRepoStatus));
  return {
    ok: true,
    action: 'repo_status_list',
    changed: false,
    message: `Listed ${repos.length} configured repo${repos.length === 1 ? '' : 's'}.`,
    repos: repos.map(asJsonValue),
    attention: repos
      .filter((repo) => repo.dirty || repo.error || (repo.behind ?? 0) > 0)
      .map(asJsonValue),
  };
}

function autopilotDoctorCheck(
  readiness: AutopilotReadiness | null,
  targetSpecific: boolean,
): DoctorCheck {
  if (!readiness) {
    return {
      id: 'autopilot-readiness',
      label: 'Autopilot readiness',
      status: targetSpecific ? 'attention' : 'ok',
      message: targetSpecific
        ? 'Autopilot readiness could not be evaluated for the requested target.'
        : 'Configure a repository, then pass --repo and --pr for live Autopilot credential checks.',
    };
  }
  const attention =
    readiness.blocking.length > 0 ||
    (targetSpecific && readiness.warnings.length > 0);
  return {
    id: 'autopilot-readiness',
    label: 'Autopilot readiness',
    status: attention ? 'attention' : 'ok',
    message: readiness.message,
    data: asJsonValue({
      repoId: readiness.repoId,
      prNumber: readiness.prNumber,
      mode: readiness.mode,
      blocking: readiness.blocking,
      warnings: readiness.warnings,
      facts: readiness.facts,
    }),
  };
}

function repoHealthCheck(
  repos: Awaited<ReturnType<typeof readRepoHealthSnapshot>>,
): DoctorCheck {
  const attention = repos.repos.filter(
    (repo) => repo.error || repo.dirty || (repo.behind ?? 0) > 0,
  );

  return {
    id: 'repos',
    label: 'Repository health',
    status: attention.length > 0 ? 'attention' : 'ok',
    message:
      attention.length > 0
        ? `${attention.length} configured repo${attention.length === 1 ? '' : 's'} need attention.`
        : `${repos.count} configured repo${repos.count === 1 ? '' : 's'} checked.`,
    data: {
      repos: repos.repos.map(asJsonValue),
      attention: attention.map((repo) => repo.id),
    },
  };
}

function packageScriptsCheck(
  rootPackage: PackageSnapshot,
  repoPackages: PackageSnapshot[],
): DoctorCheck {
  const requiredRootScripts = ['check', 'test', 'typecheck', 'dev'];
  const missing = requiredRootScripts.filter(
    (script) => !rootPackage.scripts[script],
  );
  const repoScriptCounts = repoPackages.map((item) => ({
    path: item.path,
    scripts: Object.keys(item.scripts).length,
    ...(item.error ? { error: item.error } : {}),
  }));

  return {
    id: 'package-scripts',
    label: 'Package scripts',
    status: missing.length > 0 ? 'attention' : 'ok',
    message:
      missing.length > 0
        ? `Root package is missing scripts: ${missing.join(', ')}.`
        : `Root package exposes ${Object.keys(rootPackage.scripts).length} scripts.`,
    data: {
      root: {
        path: rootPackage.path,
        scripts: rootPackage.scripts,
        missing,
      },
      repos: repoScriptCounts,
    },
  };
}

function nodeVersionCheck(): DoctorCheck {
  const expected = readTextIfExists(join(rootDir, '.node-version'))?.trim();
  const actual = process.versions.node;
  const status =
    expected && actual !== expected && !actual.startsWith(`${expected}.`)
      ? 'attention'
      : 'ok';

  return {
    id: 'node-version',
    label: 'Node version',
    status,
    message: expected
      ? `Running Node ${actual}; workspace expects ${expected}.`
      : `Running Node ${actual}; no .node-version file was found.`,
    data: {
      actual,
      expected: expected ?? null,
    },
  };
}

function envCheck(
  localEnv: Map<string, string>,
  config: AppConfig | undefined,
  repos: Awaited<ReturnType<typeof readRepoHealthSnapshot>>,
): {
  missing: string[];
  check: DoctorCheck;
} {
  const requirements = envRequirements(localEnv, config, repos);
  const missing = requirements
    .filter(
      (requirement) =>
        !hasEnvKey(requirement.id, localEnv) &&
        !(requirement.aliases ?? []).some((alias) =>
          hasEnvKey(alias, localEnv),
        ),
    )
    .map((requirement) => requirement.id);

  return {
    missing,
    check: {
      id: 'env',
      label: 'Environment keys',
      status: missing.length > 0 ? 'attention' : 'ok',
      message:
        missing.length > 0
          ? `Missing local environment keys: ${missing.join(', ')}.`
          : 'Required local environment keys are present.',
      data: {
        missing,
        present: requirements
          .map((requirement) => requirement.id)
          .filter((key) => !missing.includes(key)),
        optional: {
          GITHUB_LOGIN: hasEnvKey('GITHUB_LOGIN', localEnv),
          KILOCODE_ORGANIZATION_ID: hasEnvKey(
            'KILOCODE_ORGANIZATION_ID',
            localEnv,
          ),
        },
      },
    },
  };
}

async function readAppConfig(paths: RuntimePaths) {
  try {
    return await readRuntimeJson(paths.config, parseAppConfig);
  } catch {
    return undefined;
  }
}

function envRequirements(
  localEnv: Map<string, string>,
  config: AppConfig | undefined,
  repos: Awaited<ReturnType<typeof readRepoHealthSnapshot>>,
): EnvRequirement[] {
  const env = mergedEnv(localEnv);
  const models = resolveAgentModelSelection(
    config ? { models: config.models } : undefined,
    env,
  );
  const modelProviders =
    requiredModelProviders(models).filter(isRegisteredProvider);
  const requirements = new Map<string, EnvRequirement>();

  for (const provider of modelProviders) {
    const requirement = providerEnvRequirement(provider, config, env);
    if (requirement) requirements.set(requirement.id, requirement);
  }

  if (repos.count > 0) requirements.set('GITHUB_TOKEN', { id: 'GITHUB_TOKEN' });

  return Array.from(requirements.values());
}

function providerEnvRequirement(
  provider: RegisteredProviderId,
  config: AppConfig | undefined,
  env: NodeJS.ProcessEnv,
): EnvRequirement | undefined {
  if (provider === 'kilocode') {
    const status = resolveKilocodeProviderStatus(
      config ? { providers: config.providers } : undefined,
      env,
    );
    if (!status.enabled) return undefined;
    return {
      id: status.apiKeyEnv,
    };
  }

  if (provider === 'openai') {
    const status = resolveOpenAiProviderStatus(
      config ? { providers: config.providers } : undefined,
      env,
    );
    return status.enabled ? { id: status.apiKeyEnv } : undefined;
  }

  const status = resolveAnthropicProviderStatus(
    config ? { providers: config.providers } : undefined,
    env,
  );
  return status.enabled ? { id: status.apiKeyEnv } : undefined;
}

function mergedEnv(localEnv: Map<string, string>): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(localEnv),
    ...process.env,
  } as NodeJS.ProcessEnv;
}

function portsCheck(ports: Array<{ id: string; port: number; open: boolean }>) {
  const closed = ports.filter((port) => !port.open);

  return {
    id: 'ports',
    label: 'Dev ports',
    status: closed.length > 0 ? 'attention' : 'ok',
    message:
      closed.length > 0
        ? `Closed dev ports: ${closed.map((port) => port.port).join(', ')}.`
        : 'Dashboard and API dev ports are accepting connections.',
    data: {
      ports: ports.map(asJsonValue),
    },
  } satisfies DoctorCheck;
}

async function serverHealthCheck(): Promise<DoctorCheck> {
  try {
    const response = await fetchWithTimeout('http://127.0.0.1:3583/api/health');
    const raw = await response.json().catch(() => ({}));
    const parsed = v.safeParse(healthResponseSchema, raw);
    const ok = response.ok && parsed.success && parsed.output.ok;

    return {
      id: 'server',
      label: 'API server',
      status: ok ? 'ok' : 'attention',
      message: ok
        ? 'Neondeck API health endpoint is responding.'
        : `Neondeck API health endpoint returned ${response.status}.`,
      data: parsed.success
        ? asJsonValue(parsed.output)
        : { error: v.summarize(parsed.issues) },
    };
  } catch (error) {
    return {
      id: 'server',
      label: 'API server',
      status: 'attention',
      message: `Neondeck API health endpoint is not reachable: ${errorMessage(error)}.`,
    };
  }
}

function databaseCheck(paths: RuntimePaths): DoctorCheck {
  const databases = [
    { id: 'neondeck', path: paths.neondeckDatabase },
    { id: 'flue', path: paths.flueDatabase },
  ].map((database) => ({
    ...database,
    exists: existsSync(database.path),
  }));
  const missing = databases.filter((database) => !database.exists);

  return {
    id: 'databases',
    label: 'Runtime databases',
    status: missing.length > 0 ? 'attention' : 'ok',
    message:
      missing.length > 0
        ? `Missing runtime database files: ${missing.map((item) => item.id).join(', ')}.`
        : 'Neondeck and Flue runtime databases exist.',
    data: {
      databases: databases.map(asJsonValue),
    },
  };
}

async function readPackageSnapshot(path: string): Promise<PackageSnapshot> {
  const packagePath = join(path, 'package.json');
  try {
    const parsed = v.safeParse(
      packageJsonSchema,
      JSON.parse(await readFile(packagePath, 'utf8')),
    );
    if (!parsed.success) {
      return {
        path: packagePath,
        scripts: {},
        error: v.summarize(parsed.issues),
      };
    }

    return { path: packagePath, scripts: parsed.output.scripts ?? {} };
  } catch (error) {
    return { path: packagePath, scripts: {}, error: errorMessage(error) };
  }
}

function hasEnvKey(key: string, localEnv: Map<string, string>) {
  return Boolean(process.env[key] || localEnv.get(key));
}

async function checkPorts(
  ports: Array<{ id: string; host: string; port: number }>,
) {
  return Promise.all(
    ports.map(async (port) => ({
      id: port.id,
      port: port.port,
      open: await isPortOpen(port.host, port.port),
    })),
  );
}

function isPortOpen(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(400);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

async function fetchWithTimeout(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function readTextIfExists(path: string) {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8');
}

function asJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
