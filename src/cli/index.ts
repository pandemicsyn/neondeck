#!/usr/bin/env -S node --import=tsx
import { Command } from 'commander';
import { runInit } from './onboarding';
import { decideLearningCandidateCli } from './learning';
import { registerMcpCommands } from './mcp';
import {
  appDbModule,
  autopilotModule,
  configActionsModule,
  devDoctorModule,
  handoffModule,
  learningOperatorModule,
  openModule,
  reposModule,
  repoEditModule,
  runtimeHomeModule,
  runtimeStatusModule,
  serverModule,
  serviceModule,
  skillPatchesModule,
} from './modules';
import {
  loadEnvForPaths,
  parseAutopilotModeFlag,
  parseCandidateStatus,
  parseCandidateTarget,
  parseHandoffNoteLevel,
  parseOptionalIntervalSeconds,
  parseOptionalIntegerFlag,
  parseOptionalLimit,
  parseOptionalPositiveIntegerFlag,
  parseWatchTarget,
  pathsFromOptions,
} from './options';
import {
  printActionResult,
  printDbMigrationStatus,
  printLearningState,
  printRepoDiffResult,
  printRepoEditEventsResult,
  printServiceResult,
  printStatus,
  setJsonOutput,
} from './output';
import type {
  GlobalOptions,
  HandoffNoteOptions,
  OpenOptions,
  RegisterPrOptions,
  RepoAddOptions,
  ServiceInstallOptions,
  ServeOptions,
  WatchPrOptions,
  AutopilotOptions,
  AutopilotControlOptions,
} from './types';

const program = new Command()
  .name('neondeck')
  .description('Local developer cockpit and Flue agent control CLI.')
  .option('--home <path>', 'override runtime home')
  .option('--json', 'print machine-readable JSON where supported')
  .version('1.0.0');

program.hook('preAction', () => {
  setJsonOutput(program.opts<GlobalOptions>().json);
});

program
  .command('init')
  .description('Run the first-run Neondeck setup wizard.')
  .option('--home <path>', 'override runtime home for this run')
  .action(async (options: { home?: string }) => {
    await runInit({ home: options.home ?? program.opts<GlobalOptions>().home });
  });

program
  .command('serve')
  .description('Start the production Neondeck server in the foreground.')
  .option('--port <port>', 'override the configured/default API port')
  .action(async (options: ServeOptions) => {
    const { ensureRuntimeHome } = await runtimeHomeModule();
    const { runBuiltNeondeckServer } = await serverModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    await ensureRuntimeHome(paths);
    loadEnvForPaths(paths, { overwrite: false });
    await runBuiltNeondeckServer({
      paths,
      port: options.port,
    });
  });

program
  .command('open [profile]')
  .description('Ensure Neondeck is running and open the dashboard window.')
  .option('--port <port>', 'override the configured/default API port')
  .option('--width <pixels>', 'override Chromium app-mode window width')
  .option('--height <pixels>', 'override Chromium app-mode window height')
  .option('--x <pixels>', 'override Chromium app-mode window x position')
  .option('--y <pixels>', 'override Chromium app-mode window y position')
  .option('--kiosk', 'launch Chromium app-mode in kiosk mode')
  .option('--browser <path>', 'use a specific Chromium-family executable')
  .action(async (profile: string | undefined, options: OpenOptions) => {
    const { ensureRuntimeHome } = await runtimeHomeModule();
    const { openDashboard } = await openModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    await ensureRuntimeHome(paths);
    loadEnvForPaths(paths);
    const result = await openDashboard({
      paths,
      profile,
      port: options.port,
      browserPath: options.browser,
      overrides: {
        width: parseOptionalPositiveIntegerFlag('--width', options.width),
        height: parseOptionalPositiveIntegerFlag('--height', options.height),
        x: parseOptionalIntegerFlag('--x', options.x),
        y: parseOptionalIntegerFlag('--y', options.y),
        ...(options.kiosk ? { kiosk: true } : {}),
      },
    });
    printActionResult(result);
  });

const service = program
  .command('service')
  .description('Install and control the Neondeck login service.');

service
  .command('install')
  .description('Install and start the Neondeck login service.')
  .option('--port <port>', 'override the configured/default API port')
  .action(async (options: ServiceInstallOptions) => {
    const { ensureRuntimeHome } = await runtimeHomeModule();
    const { installService } = await serviceModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    await ensureRuntimeHome(paths);
    loadEnvForPaths(paths);
    printServiceResult(await installService({ paths, port: options.port }));
  });

service
  .command('uninstall')
  .description('Stop and remove the Neondeck login service.')
  .action(async () => {
    const { uninstallService } = await serviceModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    printServiceResult(await uninstallService(paths));
  });

service
  .command('status')
  .description(
    'Report service installation, process, health, and embedded paths.',
  )
  .action(async () => {
    const { ensureRuntimeHome } = await runtimeHomeModule();
    const { readServiceStatus } = await serviceModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    await ensureRuntimeHome(paths);
    loadEnvForPaths(paths);
    const status = await readServiceStatus(paths);
    printServiceResult({
      ok: true,
      action: 'service_status',
      changed: false,
      message: status.installed
        ? 'Read Neondeck service status.'
        : 'Neondeck service is not installed.',
      status,
    });
  });

service
  .command('start')
  .description('Start the installed Neondeck login service.')
  .action(async () => {
    const { startService } = await serviceModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    printServiceResult(await startService(paths));
  });

service
  .command('stop')
  .description('Stop the installed Neondeck login service.')
  .action(async () => {
    const { stopService } = await serviceModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    printServiceResult(await stopService(paths));
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

registerMcpCommands(program);

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

const db = program
  .command('db')
  .description('Inspect Neondeck app database state.');

db.command('status')
  .description('Read app database migration status.')
  .action(async () => {
    const { readAppDbMigrationStatus } = await appDbModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    const status = readAppDbMigrationStatus(paths.neondeckDatabase);
    printDbMigrationStatus(status);
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
    'desired terminal state: checks or merged',
    'checks',
  )
  .option('--interval <seconds>', 'poll interval in seconds')
  .option('--from <agent>', 'external agent attribution')
  .option('--json', 'print machine-readable JSON')
  .action(async (ref: string, options: WatchPrOptions) => {
    applyCommandJsonOption(options);
    const { addPrWatchWithAutopilotLease } = await autopilotModule();
    const { normalizeHandoffSource } = await handoffModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    const desiredTerminalState = parseWatchTarget(options.until);
    const intervalSeconds = parseOptionalIntervalSeconds(options.interval);
    const result = await addPrWatchWithAutopilotLease(
      {
        ref,
        desiredTerminalState,
        ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
        ...(options.from
          ? { createdBy: normalizeHandoffSource(options.from) }
          : {}),
      },
      paths,
    );
    printActionResult(result);
  });

const autopilotCommand = program
  .command('autopilot')
  .description('Configure and control Autopilot PR watches.');

autopilotCommand
  .command('watch <ref>')
  .description(
    'Configure one PR watch with an explicit per-watch Autopilot mode.',
  )
  .requiredOption(
    '--mode <mode>',
    'notify-only, prepare-only, autofix-with-approval, or autofix-push-when-safe',
  )
  .option(
    '--process-existing',
    'process current feedback on the next poll (legacy compatibility)',
  )
  .option(
    '--no-process-existing',
    'baseline current feedback and act only on later changes',
  )
  .option('--interval <seconds>', 'poll interval in seconds')
  .option('--reason <text>', 'operator-visible reason for this watch override')
  .option('--confirm', 'confirm an Autopilot authority increase')
  .option('--json', 'print machine-readable JSON')
  .action(async (ref: string, options: AutopilotOptions) => {
    applyCommandJsonOption(options);
    const { configureAutopilotWatch } = await autopilotModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    const mode = parseAutopilotModeFlag(options.mode);
    if (!mode) throw new Error('--mode is required');
    const intervalSeconds = parseOptionalIntervalSeconds(options.interval);
    printActionResult(
      await configureAutopilotWatchFromCli(
        configureAutopilotWatch,
        {
          ref,
          mode,
          processExisting: options.processExisting !== false,
          ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
          ...(options.reason ? { reason: options.reason } : {}),
        },
        paths,
        options.confirm === true,
      ),
    );
  });

for (const operation of [
  'list',
  'status',
  'pause',
  'resume',
  'stop',
  'retry',
] as const) {
  autopilotCommand
    .command(`${operation} [watchId]`)
    .description(
      `${operation} an Autopilot watch through the shared control service.`,
    )
    .option('--admission <id>', 'retry only this durable admission')
    .option('--confirm', 'confirm stopping a watch and its active work')
    .option('--json', 'print machine-readable JSON')
    .action(
      async (watchId: string | undefined, options: AutopilotControlOptions) => {
        applyCommandJsonOption(options);
        const { controlAutopilotWatch } = await autopilotModule();
        const paths = await pathsFromOptions(program.opts<GlobalOptions>());
        loadEnvForPaths(paths);
        printActionResult(
          await controlAutopilotWatch(
            {
              operation,
              ...(watchId ? { watchId } : {}),
              ...(options.admission ? { admissionId: options.admission } : {}),
              ...(options.confirm ? { confirm: true } : {}),
            },
            paths,
          ),
        );
      },
    );
}

// Compatibility aliases for scripts written before the cohesive command group.
program
  .command('autopilot-watch <ref>')
  .description('Compatibility alias for `neondeck autopilot watch <ref>`.')
  .requiredOption('--mode <mode>')
  .option('--process-existing')
  .option('--no-process-existing')
  .option('--interval <seconds>')
  .option('--reason <text>')
  .option('--confirm')
  .option('--json')
  .action(async (ref: string, options: AutopilotOptions) => {
    applyCommandJsonOption(options);
    const { configureAutopilotWatch } = await autopilotModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    const mode = parseAutopilotModeFlag(options.mode);
    if (!mode) throw new Error('--mode is required');
    const intervalSeconds = parseOptionalIntervalSeconds(options.interval);
    printActionResult(
      await configureAutopilotWatchFromCli(
        configureAutopilotWatch,
        {
          ref,
          mode,
          processExisting: options.processExisting !== false,
          ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
          ...(options.reason ? { reason: options.reason } : {}),
        },
        paths,
        options.confirm === true,
      ),
    );
  });

program
  .command('autopilot-control <operation> [watchId]')
  .description(
    'List, inspect, pause, resume, stop, or retry an Autopilot watch.',
  )
  .option('--admission <id>', 'retry only this durable admission')
  .option('--confirm', 'confirm stopping a watch and its active work')
  .option('--json', 'print machine-readable JSON')
  .action(
    async (
      operation: string,
      watchId: string | undefined,
      options: AutopilotControlOptions,
    ) => {
      applyCommandJsonOption(options);
      if (
        !['list', 'status', 'pause', 'resume', 'stop', 'retry'].includes(
          operation,
        )
      ) {
        throw new Error(
          'operation must be list, status, pause, resume, stop, or retry',
        );
      }
      const { controlAutopilotWatch } = await autopilotModule();
      const paths = await pathsFromOptions(program.opts<GlobalOptions>());
      loadEnvForPaths(paths);
      printActionResult(
        await controlAutopilotWatch(
          {
            operation: operation as
              'list' | 'status' | 'pause' | 'resume' | 'stop' | 'retry',
            ...(watchId ? { watchId } : {}),
            ...(options.admission ? { admissionId: options.admission } : {}),
            ...(options.confirm ? { confirm: true } : {}),
          },
          paths,
        ),
      );
    },
  );

program
  .command('note <text...>')
  .description(
    'Leave a bounded attributed note on the Neondeck notification stream.',
  )
  .option('--repo <ref>', 'configured repo id, name, or owner/name')
  .option('--pr <ref>', 'linked PR reference')
  .option('--level <level>', 'note level: info, ready, or attention', 'info')
  .option('--from <agent>', 'external agent attribution')
  .option('--json', 'print machine-readable JSON')
  .action(async (text: string[], options: HandoffNoteOptions) => {
    applyCommandJsonOption(options);
    const { createHandoffNote, normalizeHandoffSource } = await handoffModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    printActionResult(
      await createHandoffNote(
        {
          text: text.join(' '),
          source: normalizeHandoffSource(options.from),
          ...(options.repo ? { repo: options.repo } : {}),
          ...(options.pr ? { pr: options.pr } : {}),
          ...(options.level
            ? { level: parseHandoffNoteLevel(options.level) }
            : {}),
        },
        paths,
      ),
    );
  });

program
  .command('register-pr <ref>')
  .description(
    'Register a PR handoff with Neon by watching it, noting it, and optionally queueing review.',
  )
  .option('--from <agent>', 'external agent attribution')
  .option('--note <text>', 'one-line handoff note')
  .option('--review', 'queue bounded PR review assistance')
  .option('--no-watch', 'skip creating or confirming the PR watch')
  .option('--json', 'print machine-readable JSON')
  .action(async (ref: string, options: RegisterPrOptions) => {
    applyCommandJsonOption(options);
    const { registerHandoffPr, normalizeHandoffSource } = await handoffModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    printActionResult(
      await registerHandoffPr(
        {
          ref,
          source: normalizeHandoffSource(options.from),
          watch: options.watch,
          ...(options.review ? { review: true } : {}),
          ...(options.note ? { note: options.note } : {}),
        },
        paths,
      ),
    );
  });

program
  .command('doctor')
  .description('Run local Neondeck diagnostics.')
  .option('--repo <id>', 'check Autopilot readiness for a configured repo')
  .option('--pr <number>', 'run live API/fetch/push readiness for one PR')
  .option('--mode <mode>', 'evaluate one Autopilot delivery mode')
  .action(async (options: { repo?: string; pr?: string; mode?: string }) => {
    const { runDevDoctor } = await devDoctorModule();
    const paths = await pathsFromOptions(program.opts<GlobalOptions>());
    loadEnvForPaths(paths);
    printActionResult(
      await runDevDoctor(paths, {
        repoId: options.repo,
        prNumber: parseOptionalPositiveIntegerFlag('--pr', options.pr),
        mode: parseAutopilotModeFlag(options.mode),
      }),
    );
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

await program.parseAsync(rewriteLegacyAutopilotInvocation(process.argv));

function rewriteLegacyAutopilotInvocation(argv: string[]) {
  const commandIndex = topLevelCommandIndex(argv);
  if (commandIndex === -1 || argv[commandIndex] !== 'autopilot') return argv;
  const refIndex = legacyAutopilotRefIndex(argv, commandIndex + 1);
  if (refIndex === -1) return argv;
  const rewritten = [...argv];
  rewritten.splice(commandIndex + 1, 0, 'watch');
  const legacyArguments = argv.slice(commandIndex + 1);
  if (
    !legacyArguments.includes('--process-existing') &&
    !legacyArguments.includes('--no-process-existing')
  ) {
    const terminator = rewritten.indexOf('--', commandIndex + 2);
    rewritten.splice(
      terminator === -1 ? rewritten.length : terminator,
      0,
      '--no-process-existing',
    );
  }
  return rewritten;
}

function legacyAutopilotRefIndex(argv: string[], start: number) {
  for (let index = start; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      const candidate = argv[index + 1];
      return candidate && isLegacyAutopilotRef(candidate) ? index + 1 : -1;
    }
    if (
      argument === '--mode' ||
      argument === '--interval' ||
      argument === '--reason' ||
      argument === '--home'
    ) {
      index += 1;
      continue;
    }
    if (
      argument === '--json' ||
      argument === '--confirm' ||
      argument === '--process-existing' ||
      argument === '--no-process-existing' ||
      argument.startsWith('--home=')
    ) {
      continue;
    }
    if (
      argument.startsWith('--mode=') ||
      argument.startsWith('--interval=') ||
      argument.startsWith('--reason=')
    ) {
      continue;
    }
    return isLegacyAutopilotRef(argument) ? index : -1;
  }
  return -1;
}

function isLegacyAutopilotRef(value: string) {
  return (
    /^#\d+$/.test(value) ||
    /^[^\s/#]+#[0-9]+$/.test(value) ||
    /^[^\s/#]+\/[^\s/#]+#[0-9]+$/.test(value) ||
    /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?$/i.test(value)
  );
}

function topLevelCommandIndex(argv: string[]) {
  let index = 2;
  while (index < argv.length) {
    const argument = argv[index];
    if (
      argument === '--json' ||
      argument === '--version' ||
      argument === '-V'
    ) {
      index += 1;
      continue;
    }
    if (argument === '--home') {
      index += 2;
      continue;
    }
    if (argument.startsWith('--home=')) {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

async function configureAutopilotWatchFromCli(
  configure: (
    input: unknown,
    paths: Awaited<ReturnType<typeof pathsFromOptions>>,
  ) => Promise<unknown>,
  input: Record<string, unknown>,
  paths: Awaited<ReturnType<typeof pathsFromOptions>>,
  confirm: boolean,
): Promise<{
  ok: boolean;
  message: string;
  changed?: boolean;
  errors?: string[];
  warnings?: string[];
  requires?: string[];
}> {
  const initial = await configure(input, paths);
  if (!confirm || !requiresSetupConfirmation(initial))
    return initial as {
      ok: boolean;
      message: string;
      changed?: boolean;
      errors?: string[];
      warnings?: string[];
      requires?: string[];
    };
  return (await configure(
    {
      ...input,
      confirm: true,
      confirmation: initial.confirmation.intent,
    },
    paths,
  )) as {
    ok: boolean;
    message: string;
    changed?: boolean;
    errors?: string[];
    warnings?: string[];
    requires?: string[];
  };
}

function requiresSetupConfirmation(result: unknown): result is {
  ok: false;
  requires: string[];
  confirmation: { intent: unknown };
} {
  return Boolean(
    result &&
    typeof result === 'object' &&
    (result as { ok?: unknown }).ok === false &&
    Array.isArray((result as { requires?: unknown }).requires) &&
    (result as { requires: unknown[] }).requires.includes('confirm') &&
    (result as { confirmation?: { intent?: unknown } }).confirmation?.intent,
  );
}

function applyCommandJsonOption(options: { json?: boolean }) {
  if (options.json) setJsonOutput(true);
}
