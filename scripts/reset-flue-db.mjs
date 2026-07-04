import { constants as fsConstants } from 'node:fs';
import { access, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('Run `npm run reset:flue-db -- --help` for usage.');
  process.exit(1);
}

if (options.help) {
  printHelp();
  process.exit(0);
}

const home = resolveRuntimeHome(options.home);
const data = join(home, 'data');
const files = ['flue.db', 'flue.db-wal', 'flue.db-shm'];
const existing = [];

for (const file of files) {
  const path = join(data, file);
  if (await exists(path)) {
    existing.push({ file, path });
  }
}

if (existing.length === 0) {
  console.log(`No Flue runtime database files found under ${data}.`);
} else {
  const backupDir = join(data, `flue-db-reset-${timestamp()}`);
  await mkdir(backupDir, { recursive: true });

  for (const item of existing) {
    const target = join(backupDir, item.file);
    await rename(item.path, target);
    console.log(`Archived ${item.path} -> ${target}`);
  }
}

console.log(
  'Flue runtime database reset complete. Run `npm run dev` next to recreate it.',
);

function parseArgs(args) {
  const options = { help: false, home: undefined };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
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
  console.log(`Usage: npm run reset:flue-db -- [options]

Archive the Flue runtime SQLite database and sidecar files.
This preserves Neondeck app state in data/neondeck.db.

Options:
  --home <path>  Override runtime home for this reset.
  -h, --help     Show this help.

Without --home, reset uses NEONDECK_HOME, then XDG_CONFIG_HOME/neondeck,
then ~/.config/neondeck.`);
}

function resolveRuntimeHome(home) {
  if (home) {
    return expandHome(home);
  }

  if (process.env.NEONDECK_HOME) {
    return expandHome(process.env.NEONDECK_HOME);
  }

  if (process.env.XDG_CONFIG_HOME) {
    return join(expandHome(process.env.XDG_CONFIG_HOME), 'neondeck');
  }

  return join(process.env.HOME ?? homedir(), '.config', 'neondeck');
}

function expandHome(path) {
  if (path === '~') {
    return process.env.HOME ?? homedir();
  }

  if (path.startsWith('~/')) {
    return join(process.env.HOME ?? homedir(), path.slice(2));
  }

  return resolve(path);
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
