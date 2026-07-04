import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

type SetupOptions = {
  home?: string;
  json: boolean;
  help: boolean;
};

let options: SetupOptions;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('Run `npm run setup -- --help` for usage.');
  process.exit(1);
}

if (options.help) {
  printHelp();
  process.exit(0);
}

const { ConfigValidationError } = await import(
  new URL('./runtime-home/schemas.ts', import.meta.url).href
);
const { ensureRuntimeHome } = await import(
  new URL('./runtime-home/bootstrap.ts', import.meta.url).href
);
const { runtimePaths } = await import(
  new URL('./runtime-home/paths.ts', import.meta.url).href
);
const { validateRuntimeFiles } = await import(
  new URL('./runtime-home/files.ts', import.meta.url).href
);
const paths = runtimePaths(options.home ? expandHome(options.home) : undefined);
const trackedPaths = [
  paths.env,
  paths.config,
  paths.repos,
  paths.dashboard,
  paths.schedules,
  paths.soul,
  paths.skills,
  paths.neondeckDatabase,
  paths.flueDatabase,
];
const existedBefore = new Set(trackedPaths.filter((path) => existsSync(path)));

try {
  await ensureRuntimeHome(paths);
  await validateRuntimeFiles(paths);
  const result = {
    ok: true,
    home: paths.home,
    files: trackedPaths.map((path) => ({
      path,
      status: existedBefore.has(path) ? 'existing' : 'created',
    })),
    skills: {
      runtimeRoot: paths.skills,
      builtIn: 'src/skills/neondeck/SKILL.md',
    },
    next: {
      dev: 'npm run dev',
      health: 'curl http://127.0.0.1:5173/api/health',
      repos: 'curl http://127.0.0.1:5173/api/repos',
    },
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummary(result);
  }
} catch (error) {
  const result = {
    ok: false,
    home: paths.home,
    error:
      error instanceof ConfigValidationError
        ? 'Invalid runtime config.'
        : 'Neondeck setup failed.',
    message: error instanceof Error ? error.message : String(error),
  };

  if (options.json) {
    console.error(JSON.stringify(result, null, 2));
  } else {
    console.error(`${result.error}\n${result.message}`);
  }

  process.exitCode = 1;
}

function parseArgs(args: string[]): SetupOptions {
  const options: SetupOptions = { json: false, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--home') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('--home requires a path');
      }
      options.home = value;
      index += 1;
    } else if (arg.startsWith('--home=')) {
      options.home = arg.slice('--home='.length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: npm run setup -- [options]

Initialize or validate the Neondeck runtime home.

Options:
  --home <path>  Override runtime home for this setup run.
  --json         Print machine-readable JSON.
  -h, --help     Show this help.

Without --home, setup uses NEONDECK_HOME, then XDG_CONFIG_HOME/neondeck,
then ~/.config/neondeck.`);
}

function printSummary(result: {
  home: string;
  files: Array<{ path: string; status: string }>;
  skills: { runtimeRoot: string; builtIn: string };
  next: Record<string, string>;
}) {
  console.log(`Neondeck runtime home is ready: ${result.home}`);
  console.log('');
  console.log('Runtime files:');
  for (const file of result.files) {
    console.log(`- ${file.status.padEnd(8)} ${file.path}`);
  }
  console.log('');
  console.log(`Runtime skills root: ${result.skills.runtimeRoot}`);
  console.log(`Built-in Flue skill: ${result.skills.builtIn}`);
  console.log('');
  console.log('Next commands:');
  console.log(`- ${result.next.dev}`);
  console.log(`- ${result.next.health}`);
  console.log(`- ${result.next.repos}`);
}

function expandHome(path: string) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(path);
}
