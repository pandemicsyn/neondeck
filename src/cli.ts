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
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  loadNeondeckEnv,
  quoteEnvValue,
  readDotEnvFile,
  type EnvLoadResult,
} from './env';
import type { RuntimePaths } from './runtime-home';

type RuntimeStatus = Awaited<
  ReturnType<(typeof import('./runtime-status'))['readRuntimeStatus']>
>;

type GlobalOptions = {
  home?: string;
  json?: boolean;
};

type EnvMap = Map<string, string>;

const defaultModel = 'kilocode/kilo-auto/balanced';
type SetupModelProvider = 'kilocode' | 'openai' | 'anthropic';
type PreapprovalGroupId =
  'filesystem' | 'git-read' | 'npm' | 'pnpm' | 'bun' | 'python' | 'go';

type PreapprovalCommand = {
  id: string;
  command: string;
  match: 'exact' | 'prefix' | 'glob';
  description: string;
};

const preapprovalGroups: Array<{
  id: PreapprovalGroupId;
  label: string;
  hint: string;
  commands: PreapprovalCommand[];
}> = [
  {
    id: 'filesystem',
    label: 'Filesystem inspection',
    hint: 'pwd, ls, find, cat, sed, rg, wc.',
    commands: [
      commandPreapproval('pwd', 'pwd', 'exact', 'Print the current directory.'),
      commandPreapproval(
        'ls',
        'ls',
        'prefix',
        'List local files and directories.',
      ),
      commandPreapproval(
        'find',
        'find',
        'prefix',
        'Find local files and directories.',
      ),
      commandPreapproval('cat', 'cat', 'prefix', 'Read local text files.'),
      commandPreapproval('sed', 'sed', 'prefix', 'Read local text ranges.'),
      commandPreapproval('rg', 'rg', 'prefix', 'Search local text files.'),
      commandPreapproval(
        'wc',
        'wc',
        'prefix',
        'Count local text file lines or bytes.',
      ),
    ],
  },
  {
    id: 'git-read',
    label: 'Git inspection',
    hint: 'status, diff, show, log, branch, rev-parse.',
    commands: [
      commandPreapproval(
        'git-status',
        'git status',
        'prefix',
        'Inspect git working tree status.',
      ),
      commandPreapproval(
        'git-diff',
        'git diff',
        'prefix',
        'Inspect unstaged or staged git diffs.',
      ),
      commandPreapproval(
        'git-show',
        'git show',
        'prefix',
        'Inspect git objects and commits.',
      ),
      commandPreapproval(
        'git-log',
        'git log',
        'prefix',
        'Inspect git commit history.',
      ),
      commandPreapproval(
        'git-branch',
        'git branch',
        'prefix',
        'Inspect git branches.',
      ),
      commandPreapproval(
        'git-rev-parse',
        'git rev-parse',
        'prefix',
        'Inspect git revision and repository metadata.',
      ),
    ],
  },
  {
    id: 'npm',
    label: 'npm',
    hint: 'npm run, test, install, exec, view, list.',
    commands: [
      commandPreapproval('npm-run', 'npm run', 'prefix', 'Run npm scripts.'),
      commandPreapproval('npm-test', 'npm test', 'prefix', 'Run npm tests.'),
      commandPreapproval(
        'npm-install',
        'npm install',
        'prefix',
        'Install npm dependencies.',
      ),
      commandPreapproval('npm-exec', 'npm exec', 'prefix', 'Run npm binaries.'),
      commandPreapproval(
        'npm-view',
        'npm view',
        'prefix',
        'Read npm package metadata.',
      ),
      commandPreapproval(
        'npm-list',
        'npm list',
        'prefix',
        'List installed npm dependencies.',
      ),
    ],
  },
  {
    id: 'pnpm',
    label: 'pnpm',
    hint: 'pnpm run, test, install, exec, view, list.',
    commands: [
      commandPreapproval('pnpm-run', 'pnpm run', 'prefix', 'Run pnpm scripts.'),
      commandPreapproval('pnpm-test', 'pnpm test', 'prefix', 'Run pnpm tests.'),
      commandPreapproval(
        'pnpm-install',
        'pnpm install',
        'prefix',
        'Install pnpm dependencies.',
      ),
      commandPreapproval(
        'pnpm-exec',
        'pnpm exec',
        'prefix',
        'Run pnpm binaries.',
      ),
      commandPreapproval(
        'pnpm-view',
        'pnpm view',
        'prefix',
        'Read pnpm package metadata.',
      ),
      commandPreapproval(
        'pnpm-list',
        'pnpm list',
        'prefix',
        'List installed pnpm dependencies.',
      ),
    ],
  },
  {
    id: 'bun',
    label: 'Bun',
    hint: 'bun run, test, install, x.',
    commands: [
      commandPreapproval('bun-run', 'bun run', 'prefix', 'Run Bun scripts.'),
      commandPreapproval('bun-test', 'bun test', 'prefix', 'Run Bun tests.'),
      commandPreapproval(
        'bun-install',
        'bun install',
        'prefix',
        'Install Bun dependencies.',
      ),
      commandPreapproval('bun-x', 'bun x', 'prefix', 'Run Bun binaries.'),
    ],
  },
  {
    id: 'python',
    label: 'Python and uv',
    hint: 'python, python3, pip, uv.',
    commands: [
      commandPreapproval('python', 'python', 'prefix', 'Run Python commands.'),
      commandPreapproval(
        'python3',
        'python3',
        'prefix',
        'Run Python 3 commands.',
      ),
      commandPreapproval('pip', 'pip', 'prefix', 'Run pip commands.'),
      commandPreapproval('pip3', 'pip3', 'prefix', 'Run pip3 commands.'),
      commandPreapproval('uv', 'uv', 'prefix', 'Run uv commands.'),
    ],
  },
  {
    id: 'go',
    label: 'Go',
    hint: 'go test, run, build, list, mod.',
    commands: [
      commandPreapproval('go-test', 'go test', 'prefix', 'Run Go tests.'),
      commandPreapproval('go-run', 'go run', 'prefix', 'Run Go programs.'),
      commandPreapproval('go-build', 'go build', 'prefix', 'Build Go code.'),
      commandPreapproval('go-list', 'go list', 'prefix', 'List Go packages.'),
      commandPreapproval('go-mod', 'go mod', 'prefix', 'Manage Go modules.'),
    ],
  },
];

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
    const { ensureRuntimeHome } = await runtimeHomeModule();
    const { readRuntimeStatus } = await runtimeStatusModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    await ensureRuntimeHome(paths);
    loadEnvForPaths(paths);
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
    loadEnvForPaths(paths);
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
    loadEnvForPaths(paths);
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

repo
  .command('diff <id>')
  .description('Show a git diff summary for one configured repository.')
  .option('--base <ref>', 'base ref for git diff', 'HEAD')
  .option('--patch', 'include bounded patch text')
  .action(async (id: string, options: { base?: string; patch?: boolean }) => {
    const { readRepoDiff } = await repoEditModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    const result = await readRepoDiff(
      {
        repoId: id,
        base: options.base,
        includePatch: options.patch,
      },
      paths,
    );
    printRepoDiffResult(result);
  });

program
  .command('edit-events')
  .description('List recent repo edit audit events.')
  .action(async () => {
    const { listRepoEditEvents } = await repoEditModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    const result = await listRepoEditEvents(paths);
    printRepoEditEventsResult(result);
  });

const learning = program
  .command('learning')
  .description('Inspect and decide Neondeck learning reviews and candidates.');

learning
  .command('status')
  .description(
    'Show learning policy, counts, reviews, candidates, and audit state.',
  )
  .option('--limit <count>', 'number of rows to show')
  .action(async (options: { limit?: string }) => {
    const { readLearningOperatorState } = await learningOperatorModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    const result = await readLearningOperatorState(
      { limit: parseOptionalLimit(options.limit) },
      paths,
    );
    printLearningState(result, 'status');
  });

learning
  .command('reviews')
  .description('List recent learning reviews.')
  .option('--limit <count>', 'number of reviews to show')
  .action(async (options: { limit?: string }) => {
    const { readLearningOperatorState } = await learningOperatorModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    const result = await readLearningOperatorState(
      { limit: parseOptionalLimit(options.limit) },
      paths,
    );
    printLearningState(result, 'reviews');
  });

learning
  .command('candidates')
  .description('List memory and skill learning candidates.')
  .option(
    '--status <status>',
    'candidate status: proposed, applied, rejected, or archived',
  )
  .option('--target <target>', 'candidate target: memory or skill')
  .option('--limit <count>', 'number of candidates to show')
  .action(
    async (options: { status?: string; target?: string; limit?: string }) => {
      const { readLearningOperatorState } = await learningOperatorModule();
      const paths = await pathsFromOptions(program.opts<GlobalOptions>());
      loadEnvForPaths(paths);
      const result = await readLearningOperatorState(
        {
          limit: parseOptionalLimit(options.limit),
          candidateStatus: parseCandidateStatus(options.status),
          candidateTarget: parseCandidateTarget(options.target),
        },
        paths,
      );
      printLearningState(result, 'candidates');
    },
  );

learning
  .command('events')
  .description('List recent learning and memory audit events.')
  .option('--limit <count>', 'number of events to show')
  .action(async (options: { limit?: string }) => {
    const { readLearningOperatorState } = await learningOperatorModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    const result = await readLearningOperatorState(
      { limit: parseOptionalLimit(options.limit) },
      paths,
    );
    printLearningState(result, 'events');
  });

learning
  .command('approve <id>')
  .description('Apply one proposed memory or skill learning candidate.')
  .option('--reason <reason>', 'audit reason')
  .action(async (id: string, options: { reason?: string }) => {
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    printActionResult(
      await decideLearningCandidateCli(id, 'apply', options.reason, paths),
    );
  });

learning
  .command('reject <id>')
  .description('Reject one proposed memory or skill learning candidate.')
  .option('--reason <reason>', 'audit reason')
  .action(async (id: string, options: { reason?: string }) => {
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    printActionResult(
      await decideLearningCandidateCli(id, 'reject', options.reason, paths),
    );
  });

learning
  .command('restore-skill-patch <id>')
  .description(
    'Restore an applied skill patch from audit if the file is unchanged.',
  )
  .option('--reason <reason>', 'audit reason')
  .action(async (id: string, options: { reason?: string }) => {
    const { restoreSkillPatchCandidate } = await skillPatchesModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    const result = await restoreSkillPatchCandidate(
      {
        id,
        confirm: true,
        reason: options.reason ?? 'CLI skill patch restore.',
      },
      paths,
    );
    printActionResult(result);
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
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    const desiredTerminalState = parseWatchTarget(options.until);
    const intervalSeconds = parseOptionalIntervalSeconds(options.interval);
    const result = await addPrWatch(
      {
        ref,
        desiredTerminalState,
        ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
      },
      paths,
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
    loadEnvForPaths(paths);
    const intervalSeconds = parseOptionalIntervalSeconds(options.interval);

    if (options.morningBriefing) {
      printActionResult(
        await createScheduleBlueprint(
          {
            blueprint: 'morning-briefing',
            ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
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
            ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
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
  const envLoad = loadEnvForPaths(paths);
  spin.stop('Runtime home is ready');

  await configureSecrets(paths, envLoad);
  loadEnvForPaths(paths, { includeDevFallback: false, overwrite: true });
  await configureSoul(paths);
  await configureProviderAndModels(paths);
  await configureRepos(paths);
  await configureDashboard(paths);
  await configureExecution(paths);
  await configureSchedules(paths);
  await configureSkillRoots(paths);

  const status = await readRuntimeStatus(paths);
  const failedChecks = status.checks.filter((check) => !check.ok);
  const statusLines = [
    `home      ${paths.home}`,
    `status    ${status.status}`,
    `model     ${status.models.displayAssistant}`,
    `github    ${status.providers.credentials.github ? 'configured' : 'missing'}`,
    `kilo      ${status.providers.credentials.kilo ? 'configured' : 'missing'}`,
    `openai    ${status.providers.credentials.openai ? 'configured' : 'missing'}`,
    `anthropic ${status.providers.credentials.anthropic ? 'configured' : 'missing'}`,
    `repos     ${status.counts.repos}`,
  ];
  if (failedChecks.length > 0) {
    statusLines.push(
      '',
      'Remaining:',
      ...failedChecks.map((check) => `  ${check.label}: ${check.message}`),
    );
  }
  statusLines.push(
    '',
    'Next:',
    '  npm run dev',
    '  open http://127.0.0.1:5173/',
  );
  note(
    statusLines.join('\n'),
    status.status === 'ready'
      ? 'neondeck is ready'
      : 'neondeck runtime prepared; config remains',
  );
  outro(
    status.status === 'ready'
      ? 'The deck is live.'
      : 'Finish the remaining config, then start the deck.',
  );
}

async function configureSecrets(paths: RuntimePaths, envLoad: EnvLoadResult) {
  const { fetchGitHubLogin } = await githubModule();
  const env = await readDotEnvFile(paths.env);
  const shouldEdit = await promptConfirm({
    message:
      env.size > 0
        ? 'Review runtime-home .env secrets?'
        : 'Create runtime-home .env secrets?',
    initialValue: true,
  });
  if (!shouldEdit) return;

  const devFallback = envLoad.files.find((file) => file.id === 'dev');
  if (env.size === 0 && devFallback?.loaded) {
    log.info(
      `Using ${devFallback.path} as a dev fallback until runtime .env is written.`,
    );
  }

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

  await writeDotEnvFile(paths.env, env);
  log.success(`Wrote ${paths.env}`);

  const token = env.get('GITHUB_TOKEN');
  if (token && !env.get('GITHUB_LOGIN')) {
    const spin = spinner();
    spin.start('Checking GitHub identity');
    try {
      const login = await fetchGitHubLogin(token);
      env.set('GITHUB_LOGIN', login);
      await writeDotEnvFile(paths.env, env);
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
  const env = await readDotEnvFile(paths.env);
  const provider = await promptSelect<SetupModelProvider>({
    message: 'Model provider',
    initialValue: providerFromModel(
      env.get('FLUE_AGENT_MODEL') ?? defaultModel,
    ),
    options: [
      {
        value: 'kilocode',
        label: 'KiloCode',
        hint: 'Custom Flue provider and searchable model catalog.',
      },
      {
        value: 'openai',
        label: 'OpenAI',
        hint: 'Built-in Flue provider using OPENAI_API_KEY.',
      },
      {
        value: 'anthropic',
        label: 'Anthropic',
        hint: 'Built-in Flue provider using ANTHROPIC_API_KEY.',
      },
    ],
  });

  await configureProviderSecret(provider, env, paths);
  loadEnvForPaths(paths, { includeDevFallback: false, overwrite: true });

  const model = await chooseModel(provider, env);
  const thinkingLevel = await promptThinkingLevel();
  const utilityModel = await chooseUtilityModel(provider, env, model);

  await updateProviderConfig(providerConfigInput(provider, env), paths);
  await updateAgentModels(
    {
      displayAssistant: model,
      displayAssistantThinkingLevel: thinkingLevel,
      ...(utilityModel
        ? { utility: utilityModel, utilityThinkingLevel: 'low' }
        : {}),
      subagents: {
        default: model,
        defaultThinkingLevel: thinkingLevel,
        repoResearcher: model,
        ciInvestigator: model,
        releaseReviewer: model,
      },
    },
    paths,
  );
}

async function chooseUtilityModel(
  provider: SetupModelProvider,
  env: EnvMap,
  displayModel: string,
) {
  const mode = await promptSelect<'default' | 'manual' | 'skip'>({
    message: 'Utility model',
    initialValue: 'default',
    options: [
      {
        value: 'default',
        label: 'Use display model',
        hint: 'Skip for now; Neondeck will recommend a cheaper model later.',
      },
      {
        value: 'manual',
        label: 'Choose low-cost model',
        hint: 'For short titles, labels, notifications, and classifications.',
      },
      { value: 'skip', label: 'Skip' },
    ],
  });

  if (mode !== 'manual') return undefined;
  if (provider === 'kilocode') return chooseModel(provider, env);
  return promptModelText(provider, displayModel, 'Utility model');
}

async function configureProviderSecret(
  provider: SetupModelProvider,
  env: EnvMap,
  paths: RuntimePaths,
) {
  if (provider === 'kilocode') {
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
  } else {
    const key = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    const label = provider === 'openai' ? 'OpenAI' : 'Anthropic';
    const value = await promptPassword({
      message: env.get(key)
        ? `${label} API key (blank keeps existing)`
        : `${label} API key`,
      required: !env.get(key),
    });
    if (value) env.set(key, value);
  }

  await writeDotEnvFile(paths.env, env);
  log.success(`Wrote ${paths.env}`);
}

async function chooseModel(provider: SetupModelProvider, env: EnvMap) {
  if (provider !== 'kilocode') {
    return promptModelText(provider, defaultProviderModel(provider));
  }

  const { discoverModels } = await modelDiscoveryModule();
  const spin = spinner();
  spin.start('Discovering KiloCode models');
  const result = await discoverModels({
    provider,
    apiKey: env.get('KILOCODE_API_KEY'),
    organizationId: env.get('KILOCODE_ORGANIZATION_ID'),
  });
  spin.stop(
    result.ok
      ? `Discovered ${result.models.length} KiloCode models`
      : 'KiloCode discovery unavailable',
  );
  if (!result.ok && result.error) log.warn(result.error);

  const mode = await promptSelect<'search' | 'default' | 'manual'>({
    message: 'KiloCode model',
    initialValue: 'default',
    options: [
      {
        value: 'default',
        label: defaultModel,
        hint: 'Use the recommended default.',
      },
      {
        value: 'search',
        label: 'Search models',
        hint: 'Filter discovered KiloCode models.',
      },
      { value: 'manual', label: 'Manual entry' },
    ],
  });

  if (mode === 'default') return defaultModel;
  if (mode === 'manual') return promptModelText(provider, defaultModel);

  const query = await promptText({
    message: 'Search KiloCode models',
    placeholder: 'sonnet, gpt, kimi, free',
  });
  const matches = result.models
    .filter((model) => {
      const text = `${model.id} ${model.name}`.toLowerCase();
      return text.includes(query.trim().toLowerCase());
    })
    .slice(0, 12);

  if (matches.length === 0) {
    log.warn('No discovered models matched that search.');
    return promptModelText(provider, defaultModel);
  }

  return promptSelect<string>({
    message: 'Select model',
    options: matches.map((model) => ({
      value: model.id,
      label: model.id,
      hint: [
        model.name,
        model.contextLength ? `${model.contextLength} ctx` : null,
        model.reasoning ? 'reasoning' : null,
        model.isFree ? 'free' : null,
      ]
        .filter(Boolean)
        .join(' · '),
    })),
  });
}

async function promptModelText(
  provider: SetupModelProvider,
  initialValue: string,
  message = 'Display assistant model',
) {
  return promptText({
    message,
    placeholder: initialValue,
    initialValue,
    validate(value) {
      if (!value?.includes('/')) {
        return `Use a provider-qualified model, for example ${initialValue}.`;
      }

      if (value.split('/')[0] !== provider) {
        return `Use a ${provider}/... model for the selected provider.`;
      }

      return undefined;
    },
  });
}

async function promptThinkingLevel() {
  return promptSelect<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>({
    message: 'Thinking level',
    initialValue: 'medium',
    options: [
      { value: 'medium', label: 'medium', hint: 'Balanced default.' },
      { value: 'high', label: 'high', hint: 'More careful reasoning.' },
      { value: 'low', label: 'low', hint: 'Lower cost or latency.' },
      {
        value: 'minimal',
        label: 'minimal',
        hint: 'Smallest reasoning effort.',
      },
      { value: 'off', label: 'off', hint: 'Do not request extra reasoning.' },
      { value: 'xhigh', label: 'xhigh', hint: 'Highest exposed effort tier.' },
    ],
  });
}

function providerConfigInput(provider: SetupModelProvider, env: EnvMap) {
  if (provider === 'kilocode') {
    return {
      provider,
      enabled: true,
      apiKeyEnv: 'KILOCODE_API_KEY',
      organizationIdEnv: env.get('KILOCODE_ORGANIZATION_ID')
        ? 'KILOCODE_ORGANIZATION_ID'
        : null,
    };
  }

  return {
    provider,
    enabled: true,
    apiKeyEnv: provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY',
  };
}

function defaultProviderModel(provider: SetupModelProvider) {
  if (provider === 'openai') return 'openai/gpt-5.5';
  if (provider === 'anthropic') return 'anthropic/claude-sonnet-4-6';
  return defaultModel;
}

function providerFromModel(model: string): SetupModelProvider {
  const provider = model.includes('/') ? model.split('/')[0] : 'kilocode';
  if (provider === 'openai' || provider === 'anthropic') return provider;
  return 'kilocode';
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
  const preapprove = await promptMultiselect<PreapprovalGroupId>({
    message: 'Preapprove safe local commands?',
    options: preapprovalGroups.map((group) => ({
      value: group.id,
      label: group.label,
      hint: group.hint,
    })),
    initialValues: preapprovalGroups.map((group) => group.id),
  });
  if (preapprove.length === 0) return;

  const selectedGroups = preapprovalGroups.filter((group) =>
    preapprove.includes(group.id),
  );
  const preapprovedCommands = selectedGroups.flatMap((group) => group.commands);

  await updateExecutionPolicy(
    {
      defaultBackend: 'local',
      enabledBackends: ['local'],
      approvalMode: 'manual',
      unattended: 'deny',
      preapprovedCommands: preapprovedCommands.map((command) => ({
        ...command,
        backends: ['local'],
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
  const { readConfig, updateSkillRoots } = await configActionsModule();
  const config = await readConfig({ target: 'config' }, paths);
  const current = readConfigData(config).skillRoots ?? [];
  const detectedRoots = detectExternalSkillRoots();
  const selectableDetectedRoots = detectedRoots.filter(
    (root) => !current.includes(root),
  );
  const selectedDetectedRoots =
    selectableDetectedRoots.length > 0
      ? await promptMultiselect<string>({
          message: 'Add detected external runtime skill roots?',
          options: selectableDetectedRoots.map((root) => ({
            value: root,
            label: root,
          })),
          initialValues: selectableDetectedRoots,
        })
      : [];

  const shouldAddManual = await promptConfirm({
    message: 'Add another external runtime skill root?',
    initialValue: false,
  });
  const manualRoot = shouldAddManual
    ? await promptText({
        message: 'Skill root path',
        placeholder: '/Users/alice/.agents/skills',
        validate: requiredText,
      })
    : undefined;

  const next = Array.from(
    new Set([
      ...current,
      ...selectedDetectedRoots,
      ...(manualRoot ? [expandHome(manualRoot)] : []),
    ]),
  );
  if (next.length === current.length) return;

  const result = await updateSkillRoots({ skillRoots: next }, paths);
  if (result.ok) log.success(result.message);
  else log.warn(result.message);
}

function detectExternalSkillRoots() {
  return [join(homedir(), '.agents', 'skills')].filter((root) =>
    existsSync(root),
  );
}

function commandPreapproval(
  id: string,
  command: string,
  match: PreapprovalCommand['match'],
  description: string,
): PreapprovalCommand {
  return { id, command, match, description };
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

async function decideLearningCandidateCli(
  id: string,
  decision: 'apply' | 'reject',
  reason: string | undefined,
  paths: RuntimePaths,
) {
  const { decideMemoryCandidate } = await memoryActionsModule();
  const memoryResult = await decideMemoryCandidate(
    {
      id,
      decision,
      reason: reason ?? `CLI learning candidate ${decision}.`,
    },
    paths,
  );
  if (memoryResult.ok || !memoryCandidateWasNotFound(memoryResult)) {
    return memoryResult;
  }

  const { applySkillPatchCandidate, rejectSkillPatchCandidate } =
    await skillPatchesModule();
  return decision === 'apply'
    ? applySkillPatchCandidate(
        { id, reason: reason ?? 'CLI skill patch approval.' },
        paths,
      )
    : rejectSkillPatchCandidate(
        { id, reason: reason ?? 'CLI skill patch rejection.' },
        paths,
      );
}

function memoryCandidateWasNotFound(result: unknown) {
  if (!result || typeof result !== 'object') return false;
  const record = result as { message?: unknown; requires?: unknown };
  return (
    record.message === 'Memory candidate was not found.' &&
    Array.isArray(record.requires) &&
    record.requires.includes('id')
  );
}

async function pathsFromOptions(options: GlobalOptions) {
  const { runtimePaths } = await runtimeHomeModule();
  return runtimePaths(options.home ? expandHome(options.home) : undefined);
}

function loadEnvForPaths(
  paths: RuntimePaths,
  options: { includeDevFallback?: boolean; overwrite?: boolean } = {},
) {
  return loadNeondeckEnv(paths, options);
}

function parseWatchTarget(value: string | undefined) {
  if (value === 'checks' || value === 'merged' || value === 'prod')
    return value;
  throw new Error('--until must be checks, merged, or prod');
}

function parseOptionalIntervalSeconds(value: string | undefined) {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('--interval must be an integer >= 60');
  }
  const seconds = Number(trimmed);
  if (!Number.isSafeInteger(seconds) || seconds < 60) {
    throw new Error('--interval must be an integer >= 60');
  }
  return seconds;
}

function parseOptionalLimit(value: string | undefined) {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('--limit must be an integer from 1 to 100');
  }
  const limit = Number(trimmed);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('--limit must be an integer from 1 to 100');
  }
  return limit;
}

function parseCandidateStatus(value: string | undefined) {
  if (value === undefined) return undefined;
  if (
    value === 'proposed' ||
    value === 'applied' ||
    value === 'rejected' ||
    value === 'archived'
  ) {
    return value;
  }
  throw new Error('--status must be proposed, applied, rejected, or archived');
}

function parseCandidateTarget(value: string | undefined) {
  if (value === undefined) return undefined;
  if (value === 'memory' || value === 'skill') return value;
  throw new Error('--target must be memory or skill');
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

function printLearningState(
  result: unknown,
  view: 'status' | 'reviews' | 'candidates' | 'events',
) {
  if (program.opts<GlobalOptions>().json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result || typeof result !== 'object') {
    console.log('Learning state unavailable.');
    process.exitCode = 1;
    return;
  }
  const state = result as Record<string, unknown>;
  if (state.ok === false) {
    printActionResult({
      ok: false,
      message:
        typeof state.message === 'string'
          ? state.message
          : 'Learning state failed.',
    });
    return;
  }

  const summary = objectField(state.summary);
  if (view === 'status') {
    console.log('learning:ready');
    console.log(`pending   ${numberField(summary, 'pendingDecisions')}`);
    console.log(`failed    ${numberField(summary, 'failedReviews')}`);
    console.log(`memories  ${numberField(summary, 'activeMemories')} active`);
    console.log(`PR events ${numberField(summary, 'handledPrEvents')}`);
  }

  if (view === 'status' || view === 'reviews') {
    const reviews = arrayField(state.reviews);
    if (view === 'reviews') console.log(`reviews ${reviews.length}`);
    for (const review of reviews.slice(
      0,
      view === 'status' ? 5 : reviews.length,
    )) {
      const item = objectField(review);
      console.log(
        `${stringField(item, 'startedAt')} ${stringField(item, 'status').padEnd(9)} ${stringField(item, 'kind').padEnd(12)} ${stringField(item, 'id')}`,
      );
    }
  }

  if (view === 'status' || view === 'candidates') {
    const candidates = arrayField(state.candidates);
    if (view === 'candidates') console.log(`candidates ${candidates.length}`);
    for (const candidate of candidates.slice(
      0,
      view === 'status' ? 8 : candidates.length,
    )) {
      const item = objectField(candidate);
      const label =
        stringField(item, 'skillId') ||
        [stringField(item, 'scope'), stringField(item, 'key')]
          .filter(Boolean)
          .join(':') ||
        stringField(item, 'id');
      console.log(
        `${stringField(item, 'createdAt')} ${stringField(item, 'status').padEnd(9)} ${stringField(item, 'target').padEnd(6)} ${label}`,
      );
      const reason = stringField(item, 'reason');
      if (reason) console.log(`  ${reason}`);
    }
  }

  if (view === 'events') {
    const events = [
      ...arrayField(state.learningEvents),
      ...arrayField(state.memoryEvents),
    ]
      .map(objectField)
      .sort(
        (a, b) =>
          Date.parse(stringField(b, 'createdAt')) -
          Date.parse(stringField(a, 'createdAt')),
      );
    console.log(`events ${events.length}`);
    for (const event of events) {
      const label = stringField(event, 'type') || stringField(event, 'action');
      console.log(
        `${stringField(event, 'createdAt')} ${label.padEnd(26)} ${stringField(event, 'source') || stringField(event, 'actor')}`,
      );
    }
  }
}

function printRepoDiffResult(result: {
  ok: boolean;
  message: string;
  files?: unknown[];
  diffSummary?: {
    files: number;
    additions: number;
    deletions: number;
    binaryFiles: number;
  };
  errors?: string[];
}) {
  if (program.opts<GlobalOptions>().json || !result.ok) {
    printActionResult(result);
    return;
  }

  console.log(`✓ ${result.message}`);
  const summary = result.diffSummary;
  if (summary) {
    console.log(
      `${summary.files} files, +${summary.additions} -${summary.deletions}, ${summary.binaryFiles} binary`,
    );
  }

  const files = (result.files ?? []).flatMap((file) =>
    repoDiffFileFromUnknown(file),
  );
  if (files.length === 0) {
    console.log('No changes.');
    return;
  }

  for (const file of files) {
    const markers = [
      file.binary ? 'binary' : undefined,
      file.generatedLike ? 'generated' : undefined,
      file.truncated ? 'truncated' : undefined,
    ].filter(Boolean);
    const markerText = markers.length ? ` (${markers.join(', ')})` : '';
    console.log(
      `${file.status.padEnd(10)} +${String(file.additions).padEnd(4)} -${String(file.deletions).padEnd(4)} ${file.path}${markerText}`,
    );
    if (file.patch) console.log(file.patch.trimEnd());
  }
}

function repoDiffFileFromUnknown(value: unknown) {
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  if (typeof item.path !== 'string' || typeof item.status !== 'string') {
    return [];
  }
  return [
    {
      path: item.path,
      status: item.status,
      additions: typeof item.additions === 'number' ? item.additions : 0,
      deletions: typeof item.deletions === 'number' ? item.deletions : 0,
      binary: item.binary === true,
      generatedLike: item.generatedLike === true,
      patch: typeof item.patch === 'string' ? item.patch : undefined,
      truncated: item.truncated === true,
    },
  ];
}

function printRepoEditEventsResult(result: {
  ok: boolean;
  message: string;
  events?: Array<{
    id: string;
    repoId: string;
    action: string;
    status: string;
    paths: string[];
    reason: string | null;
    diffSummary: unknown;
    updatedAt: string;
  }>;
  errors?: string[];
}) {
  if (program.opts<GlobalOptions>().json || !result.ok) {
    printActionResult(result);
    return;
  }

  console.log(`✓ ${result.message}`);
  const events = result.events ?? [];
  if (events.length === 0) {
    console.log('No repo edit events recorded.');
    return;
  }

  for (const event of events) {
    const summary = diffSummaryText(event.diffSummary);
    const paths = event.paths.length ? event.paths.join(', ') : '(no paths)';
    const reason = event.reason ? ` · ${event.reason}` : '';
    console.log(
      `${event.updatedAt} ${event.status.padEnd(7)} ${event.action.padEnd(8)} ${event.repoId} ${summary}`,
    );
    console.log(`  ${paths}${reason}`);
  }
}

function diffSummaryText(value: unknown) {
  if (!value || typeof value !== 'object') return '';
  const summary = value as {
    files?: unknown;
    additions?: unknown;
    deletions?: unknown;
  };
  const files = typeof summary.files === 'number' ? summary.files : 0;
  const additions =
    typeof summary.additions === 'number' ? summary.additions : 0;
  const deletions =
    typeof summary.deletions === 'number' ? summary.deletions : 0;
  return files > 0 ? `${files} files +${additions} -${deletions}` : '';
}

function objectField(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayField(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'number' ? value : 0;
}

function printStatus(status: RuntimeStatus) {
  console.log(`neondeck:${status.status}`);
  console.log(`home      ${status.home}`);
  console.log(`env       ${status.paths.env}`);
  console.log(`model     ${status.models.displayAssistant}`);
  console.log(
    `utility  ${status.models.utilityConfigured ? status.models.utility : `${status.models.utility} (fallback)`}`,
  );
  console.log(
    `github    ${status.providers.credentials.github ? 'configured' : 'missing'}`,
  );
  console.log(
    `kilo      ${status.providers.credentials.kilo ? 'configured' : 'missing'}`,
  );
  console.log(
    `openai    ${status.providers.credentials.openai ? 'configured' : 'missing'}`,
  );
  console.log(
    `anthropic ${status.providers.credentials.anthropic ? 'configured' : 'missing'}`,
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

async function writeDotEnvFile(path: string, env: EnvMap) {
  await mkdir(dirname(path), { recursive: true });
  const orderedKeys = [
    'KILOCODE_API_KEY',
    'KILOCODE_ORGANIZATION_ID',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
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

async function learningOperatorModule() {
  return import(
    new URL('./learning-operator.ts', import.meta.url).href
  ) as Promise<typeof import('./learning-operator')>;
}

async function memoryActionsModule() {
  return import(
    new URL('./memory-actions.ts', import.meta.url).href
  ) as Promise<typeof import('./memory-actions')>;
}

async function modelDiscoveryModule() {
  return import(
    new URL('./model-discovery.ts', import.meta.url).href
  ) as Promise<typeof import('./model-discovery')>;
}

async function reposModule() {
  return import(new URL('./repos.ts', import.meta.url).href) as Promise<
    typeof import('./repos')
  >;
}

async function repoEditModule() {
  return import(
    new URL('./repo-edit/index.ts', import.meta.url).href
  ) as Promise<typeof import('./repo-edit')>;
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

async function skillPatchesModule() {
  return import(new URL('./skill-patches.ts', import.meta.url).href) as Promise<
    typeof import('./skill-patches')
  >;
}

async function watchActionsModule() {
  return import(new URL('./watch-actions.ts', import.meta.url).href) as Promise<
    typeof import('./watch-actions')
  >;
}
