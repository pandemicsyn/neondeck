#!/usr/bin/env -S tsx
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  password,
  select,
  spinner,
  text,
} from '@clack/prompts';
import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { RuntimePaths } from './runtime-home';

type RuntimeStatus = Awaited<
  ReturnType<(typeof import('./runtime-status'))['readRuntimeStatus']>
>;

type GlobalOptions = {
  home?: string;
  json?: boolean;
};

type EnvMap = Map<string, string>;

const defaultModel = 'kilocode/kilo/auto';
const envPath = resolve('.env');

const program = new Command()
  .name('neondeck')
  .description('Local developer cockpit and Flue agent control CLI.')
  .option('--home <path>', 'override runtime home')
  .option('--json', 'print machine-readable JSON where supported')
  .version('1.0.0');

program
  .command('init')
  .description('Run the first-run Neondeck setup wizard.')
  .option('--home <path>', 'override runtime home for this run')
  .action(async (options: { home?: string }) => {
    await runInit({ home: options.home ?? program.opts<GlobalOptions>().home });
  });

program
  .command('status')
  .description('Read runtime readiness and configured paths.')
  .action(async () => {
    loadDotEnvFile(envPath);
    const { ensureRuntimeHome } = await runtimeHomeModule();
    const { readRuntimeStatus } = await runtimeStatusModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    await ensureRuntimeHome(paths);
    const status = await readRuntimeStatus(paths);
    if (program.opts<GlobalOptions>().json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    printStatus(status);
  });

const repo = program
  .command('repo')
  .description('Manage configured repositories.');

repo
  .command('add <path>')
  .description('Add a local git checkout to the Neondeck repo registry.')
  .option('--id <id>', 'repo id')
  .option('--github-owner <owner>', 'GitHub owner')
  .option('--github-name <name>', 'GitHub repo name')
  .option('--default-branch <branch>', 'default branch')
  .option('--production-target <target>', 'production target label')
  .action(async (repoPath: string, options: RepoAddOptions) => {
    const { addRepo } = await configActionsModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    const result = await addRepo(
      {
        path: repoPath,
        ...(options.id ? { id: options.id } : {}),
        ...(options.githubOwner ? { githubOwner: options.githubOwner } : {}),
        ...(options.githubName ? { githubName: options.githubName } : {}),
        ...(options.defaultBranch
          ? { defaultBranch: options.defaultBranch }
          : {}),
        ...(options.productionTarget
          ? { productionTarget: options.productionTarget }
          : {}),
      },
      paths,
    );
    printActionResult(result);
  });

repo
  .command('list')
  .description('List configured repositories.')
  .action(async () => {
    const { readRepoRegistrySnapshot } = await reposModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    const snapshot = await readRepoRegistrySnapshot(paths);
    if (program.opts<GlobalOptions>().json) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }

    if (snapshot.repos.length === 0) {
      console.log('No repositories configured.');
      return;
    }

    for (const item of snapshot.repos) {
      console.log(
        `${item.id.padEnd(18)} ${item.github.owner}/${item.github.name}  ${item.path}`,
      );
    }
  });

program
  .command('watch-pr <ref>')
  .description('Create a persistent PR watch.')
  .option(
    '--until <state>',
    'desired terminal state: checks, merged, or prod',
    'checks',
  )
  .option('--interval <seconds>', 'poll interval in seconds')
  .action(async (ref: string, options: WatchPrOptions) => {
    const { addPrWatch } = await watchActionsModule();
    const desiredTerminalState = parseWatchTarget(options.until);
    const intervalSeconds = options.interval
      ? Number(options.interval)
      : undefined;
    const result = await addPrWatch(
      {
        ref,
        desiredTerminalState,
        ...(intervalSeconds ? { intervalSeconds } : {}),
      },
      await pathsFromOptions(program.opts<GlobalOptions>()),
    );
    printActionResult(result);
  });

program
  .command('schedule [request...]')
  .description('Create or inspect Neondeck schedules.')
  .option('--morning-briefing', 'create the morning briefing blueprint')
  .option('--review-queue-digest', 'create the review queue digest blueprint')
  .option('--interval <seconds>', 'poll interval in seconds')
  .action(async (request: string[] | undefined, options: ScheduleOptions) => {
    const { createScheduleBlueprint, listSchedulerJobs } =
      await schedulerModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    const intervalSeconds = options.interval
      ? Number(options.interval)
      : undefined;

    if (options.morningBriefing) {
      printActionResult(
        await createScheduleBlueprint(
          {
            blueprint: 'morning-briefing',
            ...(intervalSeconds ? { intervalSeconds } : {}),
          },
          paths,
        ),
      );
      return;
    }

    if (options.reviewQueueDigest) {
      printActionResult(
        await createScheduleBlueprint(
          {
            blueprint: 'review-queue-digest',
            ...(intervalSeconds ? { intervalSeconds } : {}),
          },
          paths,
        ),
      );
      return;
    }

    const naturalLanguage = request?.join(' ').trim();
    if (naturalLanguage) {
      console.error(
        'Natural-language scheduling is not implemented yet. Use --morning-briefing or --review-queue-digest for now.',
      );
      process.exitCode = 1;
      return;
    }

    const jobs = await listSchedulerJobs(paths);
    printActionResult(jobs);
  });

program
  .command('tui')
  .description('Launch the future OpenTUI client.')
  .action(() => {
    console.log(
      'The Neondeck TUI is not implemented yet. This command is reserved for the future OpenTUI client.',
    );
  });

program
  .command('dev')
  .description('Start the local web dashboard and backend.')
  .action(() => {
    console.log('Run `npm run dev` for the current local web dashboard.');
  });

loadDotEnvFile(envPath);
await program.parseAsync(process.argv);

type RepoAddOptions = {
  id?: string;
  githubOwner?: string;
  githubName?: string;
  defaultBranch?: string;
  productionTarget?: string;
};

type WatchPrOptions = {
  until?: string;
  interval?: string;
};

type ScheduleOptions = {
  morningBriefing?: boolean;
  reviewQueueDigest?: boolean;
  interval?: string;
};

async function runInit(options: { home?: string }) {
  intro('neondeck init');
  loadDotEnvFile(envPath);
  const { ensureRuntimeHome, runtimePaths, validateRuntimeFiles } =
    await runtimeHomeModule();
  const { readRuntimeStatus } = await runtimeStatusModule();

  const suggestedHome = options.home
    ? expandHome(options.home)
    : runtimePaths().home;
  const home = await promptText({
    message: 'Runtime home',
    placeholder: suggestedHome,
    initialValue: suggestedHome,
    validate(value) {
      return value?.trim().length === 0
        ? 'Enter a runtime home path.'
        : undefined;
    },
  });
  const paths = runtimePaths(expandHome(home));
  const spin = spinner();
  spin.start('Preparing runtime home');
  await ensureRuntimeHome(paths);
  await validateRuntimeFiles(paths);
  spin.stop('Runtime home is ready');

  await configureSecrets();
  loadDotEnvFile(envPath, true);
  await configureSoul(paths);
  await configureProviderAndModels(paths);
  await configureRepos(paths);
  await configureDashboard(paths);
  await configureExecution(paths);
  await configureSchedules(paths);
  await configureSkillRoots(paths);

  const status = await readRuntimeStatus(paths);
  note(
    [
      `home      ${paths.home}`,
      `status    ${status.status}`,
      `model     ${status.models.displayAssistant}`,
      `github    ${status.providers.credentials.github ? 'configured' : 'missing'}`,
      `kilo      ${status.providers.credentials.kilo ? 'configured' : 'missing'}`,
      `repos     ${status.counts.repos}`,
      '',
      'Next:',
      '  npm run dev',
      '  open http://127.0.0.1:5173/',
    ].join('\n'),
    'neondeck is ready',
  );
  outro('The deck is live.');
}

async function configureSecrets() {
  const { fetchGitHubLogin } = await githubModule();
  const env = await readDotEnvFile(envPath);
  const shouldEdit = await promptConfirm({
    message: existsSync(envPath)
      ? 'Review local .env secrets?'
      : 'Create local .env secrets?',
    initialValue: true,
  });
  if (!shouldEdit) return;

  const kiloKey = await promptPassword({
    message: env.get('KILOCODE_API_KEY')
      ? 'Kilo API key (blank keeps existing)'
      : 'Kilo API key',
    required: !env.get('KILOCODE_API_KEY'),
  });
  if (kiloKey) env.set('KILOCODE_API_KEY', kiloKey);

  const orgId = await promptText({
    message: 'Kilo organization id',
    placeholder: env.get('KILOCODE_ORGANIZATION_ID') ?? 'optional',
    initialValue: env.get('KILOCODE_ORGANIZATION_ID') ?? '',
  });
  if (orgId.trim()) env.set('KILOCODE_ORGANIZATION_ID', orgId.trim());
  else env.delete('KILOCODE_ORGANIZATION_ID');

  const githubToken = await promptPassword({
    message: env.get('GITHUB_TOKEN')
      ? 'GitHub token (blank keeps existing)'
      : 'GitHub token',
    required: !env.get('GITHUB_TOKEN'),
  });
  if (githubToken) env.set('GITHUB_TOKEN', githubToken);

  const githubLogin = await promptText({
    message: 'GitHub login',
    placeholder: 'optional; auto-detected when blank',
    initialValue: env.get('GITHUB_LOGIN') ?? '',
  });
  if (githubLogin.trim()) env.set('GITHUB_LOGIN', githubLogin.trim());
  else env.delete('GITHUB_LOGIN');

  if (!env.get('FLUE_AGENT_MODEL')) env.set('FLUE_AGENT_MODEL', defaultModel);
  await writeDotEnvFile(envPath, env);
  log.success(`Wrote ${envPath}`);

  const token = env.get('GITHUB_TOKEN');
  if (token && !env.get('GITHUB_LOGIN')) {
    const spin = spinner();
    spin.start('Checking GitHub identity');
    try {
      const login = await fetchGitHubLogin(token);
      env.set('GITHUB_LOGIN', login);
      await writeDotEnvFile(envPath, env);
      spin.stop(`GitHub login detected: ${login}`);
    } catch (error) {
      spin.stop('GitHub login could not be detected');
      log.warn(error instanceof Error ? error.message : String(error));
    }
  }
}

async function configureSoul(paths: RuntimePaths) {
  const shouldEdit = await promptConfirm({
    message: 'Tune Neon’s SOUL.md?',
    initialValue: true,
  });
  if (!shouldEdit) return;

  const name = await promptText({
    message: 'Agent name',
    placeholder: 'Neon',
    initialValue: 'Neon',
    validate: requiredText,
  });
  const emoji = await promptText({
    message: 'Agent emoji',
    placeholder: '🟢',
    initialValue: '🟢',
    validate: requiredText,
  });
  const vibe = await promptText({
    message: 'Vibe',
    placeholder: 'Concise, observant, practical; favors concrete next actions.',
    initialValue:
      'A calm, technical companion for a developer side display. Concise, observant, and practical.',
    validate: requiredText,
  });

  await writeFile(
    paths.soul,
    [
      '# Soul',
      '',
      `name: ${name}`,
      `emoji: ${emoji}`,
      '',
      '## Vibe',
      '',
      vibe,
      '',
    ].join('\n'),
    'utf8',
  );
  log.success(`Updated ${paths.soul}`);
}

async function configureProviderAndModels(paths: RuntimePaths) {
  const { updateAgentModels, updateProviderConfig } =
    await configActionsModule();
  const model = await promptText({
    message: 'Display assistant model',
    placeholder: defaultModel,
    initialValue: process.env.FLUE_AGENT_MODEL ?? defaultModel,
    validate(value) {
      return value?.includes('/')
        ? undefined
        : 'Use a provider-qualified model, for example kilocode/kilo/auto.';
    },
  });

  await updateProviderConfig(
    {
      provider: 'kilocode',
      enabled: true,
      apiKeyEnv: 'KILOCODE_API_KEY',
      organizationIdEnv: process.env.KILOCODE_ORGANIZATION_ID
        ? 'KILOCODE_ORGANIZATION_ID'
        : null,
    },
    paths,
  );
  await updateAgentModels(
    {
      displayAssistant: model,
      subagents: {
        default: model,
        repoResearcher: model,
        ciInvestigator: model,
        releaseReviewer: model,
      },
    },
    paths,
  );
}

async function configureRepos(paths: RuntimePaths) {
  const mode = await promptSelect<'manual' | 'scan' | 'skip'>({
    message: 'Add repositories?',
    initialValue: 'manual',
    options: [
      {
        value: 'manual',
        label: 'Add paths',
        hint: 'Paste one local checkout at a time.',
      },
      {
        value: 'scan',
        label: 'Scan folder',
        hint: 'Find one-level-deep git checkouts.',
      },
      { value: 'skip', label: 'Skip for now' },
    ],
  });

  if (mode === 'skip') return;
  if (mode === 'scan') {
    const parent = await promptText({
      message: 'Folder to scan',
      placeholder: join(homedir(), 'Developer'),
      initialValue: join(homedir(), 'Developer'),
      validate: requiredText,
    });
    const candidates = await findGitRepos(parent);
    if (candidates.length === 0) {
      log.warn('No one-level-deep git checkouts found.');
      return;
    }

    const selected = await promptMultiselect<string>({
      message: 'Select repositories',
      options: candidates.map((candidate) => ({
        value: candidate,
        label: candidate,
      })),
    });
    for (const repoPath of selected) {
      await addRepoWithFeedback(repoPath, paths);
    }
    return;
  }

  let keepGoing = true;
  while (keepGoing) {
    const repoPath = await promptText({
      message: 'Local repo path',
      placeholder: '/Users/alice/dev/project',
      validate: requiredText,
    });
    await addRepoWithFeedback(repoPath, paths);
    keepGoing = await promptConfirm({
      message: 'Add another repo?',
      initialValue: false,
    });
  }
}

async function configureDashboard(paths: RuntimePaths) {
  const { applyDashboardPreset } = await configActionsModule();
  const preset = await promptSelect<'cockpit' | 'classic'>({
    message: 'Dashboard preset',
    initialValue: 'cockpit',
    options: [
      {
        value: 'cockpit',
        label: 'Cockpit',
        hint: 'Work queue, chat, watches, briefing, runtime.',
      },
      {
        value: 'classic',
        label: 'Classic',
        hint: 'GitHub left, Neon right.',
      },
    ],
  });
  const statuslinePosition = await promptSelect<'top' | 'bottom'>({
    message: 'Statusline position',
    initialValue: 'top',
    options: [
      { value: 'top', label: 'Top' },
      { value: 'bottom', label: 'Bottom' },
    ],
  });

  await applyDashboardPreset({ preset, statuslinePosition }, paths);
}

async function configureExecution(paths: RuntimePaths) {
  const { updateExecutionPolicy } = await configActionsModule();
  const preapprove = await promptMultiselect<string>({
    message: 'Preapprove safe local commands?',
    options: [
      { value: 'npm run check', label: 'npm run check' },
      { value: 'npm test', label: 'npm test' },
      { value: 'npm run lint', label: 'npm run lint' },
      { value: 'npm run typecheck', label: 'npm run typecheck' },
    ],
  });
  if (preapprove.length === 0) return;

  await updateExecutionPolicy(
    {
      defaultBackend: 'local',
      enabledBackends: ['local'],
      approvalMode: 'manual',
      unattended: 'deny',
      preapprovedCommands: preapprove.map((command) => ({
        id: command.replaceAll(/\W+/g, '-').replace(/^-|-$/g, ''),
        command,
        match: 'exact',
        backends: ['local'],
        description: `Allow ${command} from Neon.`,
      })),
    },
    paths,
  );
}

async function configureSchedules(paths: RuntimePaths) {
  const { createScheduleBlueprint } = await schedulerModule();
  const briefing = await promptConfirm({
    message: 'Create a morning briefing schedule?',
    initialValue: false,
  });
  if (!briefing) return;

  const intervalSeconds = await promptText({
    message: 'Briefing check interval in seconds',
    placeholder: '86400',
    initialValue: '86400',
    validate(value) {
      const number = Number(value);
      return Number.isInteger(number) && number >= 60
        ? undefined
        : 'Enter an integer >= 60.';
    },
  });

  await createScheduleBlueprint(
    {
      blueprint: 'morning-briefing',
      intervalSeconds: Number(intervalSeconds),
    },
    paths,
  );
}

async function configureSkillRoots(paths: RuntimePaths) {
  const shouldAdd = await promptConfirm({
    message: 'Add an external runtime skill root?',
    initialValue: false,
  });
  if (!shouldAdd) return;

  const root = await promptText({
    message: 'Skill root path',
    placeholder: '/Users/alice/.agents/skills',
    validate: requiredText,
  });
  const { readConfig, updateSkillRoots } = await configActionsModule();
  const config = await readConfig({ target: 'config' }, paths);
  const current = readConfigData(config).skillRoots ?? [];
  const next = Array.from(new Set([...current, expandHome(root)]));
  const result = await updateSkillRoots({ skillRoots: next }, paths);
  if (result.ok) log.success(result.message);
  else log.warn(result.message);
}

async function addRepoWithFeedback(repoPath: string, paths: RuntimePaths) {
  const { addRepo } = await configActionsModule();
  const result = await addRepo({ path: repoPath }, paths);
  if (result.ok) log.success(result.message);
  else {
    log.warn(result.message);
    if (result.requires?.length) {
      log.info(`Requires: ${result.requires.join(', ')}`);
    }
  }
}

async function pathsFromOptions(options: GlobalOptions) {
  const { runtimePaths } = await runtimeHomeModule();
  return runtimePaths(options.home ? expandHome(options.home) : undefined);
}

function parseWatchTarget(value: string | undefined) {
  if (value === 'checks' || value === 'merged' || value === 'prod')
    return value;
  throw new Error('--until must be checks, merged, or prod');
}

function printActionResult(result: {
  ok: boolean;
  message: string;
  changed?: boolean;
  errors?: string[];
  requires?: string[];
}) {
  if (program.opts<GlobalOptions>().json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
  if (result.requires?.length)
    console.log(`requires: ${result.requires.join(', ')}`);
  if (result.errors?.length) {
    for (const error of result.errors) console.log(`error: ${error}`);
  }
  if (!result.ok) process.exitCode = 1;
}

function printStatus(status: RuntimeStatus) {
  console.log(`neondeck:${status.status}`);
  console.log(`home      ${status.home}`);
  console.log(`model     ${status.models.displayAssistant}`);
  console.log(
    `github    ${status.providers.credentials.github ? 'configured' : 'missing'}`,
  );
  console.log(
    `kilo      ${status.providers.credentials.kilo ? 'configured' : 'missing'}`,
  );
  console.log(`repos     ${status.counts.repos}`);
  console.log(`skills    ${status.counts.activeSkills}`);
  console.log(`watches   ${status.counts.activeWatches}`);
  const attention = status.checks.filter((check) => !check.ok);
  if (attention.length > 0) {
    console.log('');
    console.log('Needs attention:');
    for (const check of attention)
      console.log(`- ${check.label}: ${check.message}`);
  }
}

async function findGitRepos(parent: string) {
  const root = expandHome(parent);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const repos: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name);
    if (existsSync(join(candidate, '.git'))) repos.push(candidate);
  }
  return repos;
}

async function readDotEnvFile(path: string): Promise<EnvMap> {
  const env: EnvMap = new Map();
  if (!existsSync(path)) return env;
  const source = await readFile(path, 'utf8');
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env.set(match[1], unquoteEnvValue(match[2]));
  }
  return env;
}

function loadDotEnvFile(path: string, overwrite = false) {
  if (!existsSync(path)) return;
  const source = readFileSync(path, 'utf8');
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    if (overwrite || !process.env[match[1]]) {
      process.env[match[1]] = unquoteEnvValue(match[2]);
    }
  }
}

async function writeDotEnvFile(path: string, env: EnvMap) {
  await mkdir(dirname(path), { recursive: true });
  const orderedKeys = [
    'KILOCODE_API_KEY',
    'KILOCODE_ORGANIZATION_ID',
    'FLUE_AGENT_MODEL',
    'GITHUB_TOKEN',
    'GITHUB_LOGIN',
  ];
  const lines: string[] = [];
  for (const key of orderedKeys) {
    const value = env.get(key);
    if (value !== undefined) lines.push(`${key}=${quoteEnvValue(value)}`);
  }
  for (const [key, value] of env) {
    if (!orderedKeys.includes(key))
      lines.push(`${key}=${quoteEnvValue(value)}`);
  }
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
}

function unquoteEnvValue(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteEnvValue(value: string) {
  return JSON.stringify(value);
}

function expandHome(path: string) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(path);
}

function requiredText(value: string | undefined) {
  return value?.trim().length ? undefined : 'Enter a value.';
}

async function promptText(options: Parameters<typeof text>[0]) {
  const result = await text(options);
  if (isCancel(result)) abort();
  return String(result);
}

async function promptPassword(
  options: Parameters<typeof password>[0] & { required?: boolean },
) {
  const { required, ...promptOptions } = options;
  const result = await password({
    ...promptOptions,
    validate(value) {
      if (required && value?.trim().length === 0) return 'Enter a value.';
      return undefined;
    },
  });
  if (isCancel(result)) abort();
  return String(result);
}

async function promptConfirm(options: Parameters<typeof confirm>[0]) {
  const result = await confirm(options);
  if (isCancel(result)) abort();
  return Boolean(result);
}

async function promptSelect<T extends string>(
  options: Parameters<typeof select<T>>[0],
) {
  const result = await select<T>(options);
  if (isCancel(result)) abort();
  return result;
}

async function promptMultiselect<T extends string>(
  options: Parameters<typeof multiselect<T>>[0],
) {
  const result = await multiselect<T>(options);
  if (isCancel(result)) abort();
  return result;
}

function abort(): never {
  cancel('Setup cancelled.');
  process.exit(0);
}

function readConfigData(result: { data?: unknown }) {
  const data = result.data;
  if (!data || typeof data !== 'object') return {};
  const record = data as { config?: unknown };
  if (!record.config || typeof record.config !== 'object') return {};
  return record.config as { skillRoots?: string[] };
}

async function configActionsModule() {
  return import(
    new URL('./config-actions.ts', import.meta.url).href
  ) as Promise<typeof import('./config-actions')>;
}

async function githubModule() {
  return import(new URL('./github.ts', import.meta.url).href) as Promise<
    typeof import('./github')
  >;
}

async function reposModule() {
  return import(new URL('./repos.ts', import.meta.url).href) as Promise<
    typeof import('./repos')
  >;
}

async function runtimeHomeModule() {
  return import(new URL('./runtime-home.ts', import.meta.url).href) as Promise<
    typeof import('./runtime-home')
  >;
}

async function runtimeStatusModule() {
  return import(
    new URL('./runtime-status.ts', import.meta.url).href
  ) as Promise<typeof import('./runtime-status')>;
}

async function schedulerModule() {
  return import(new URL('./scheduler.ts', import.meta.url).href) as Promise<
    typeof import('./scheduler')
  >;
}

async function watchActionsModule() {
  return import(new URL('./watch-actions.ts', import.meta.url).href) as Promise<
    typeof import('./watch-actions')
  >;
}
