import { spawnSync } from 'node:child_process';

const config = 'drizzle.config.ts';

const journal = runJson('drizzle-kit check', [
  './node_modules/.bin/drizzle-kit',
  'check',
  '--output',
  'json',
  '--config',
  config,
]);
if (journal.status !== 'ok') {
  fail('Drizzle migration journal check failed.', journal);
}

const drift = runJson('drizzle-kit generate --explain', [
  './node_modules/.bin/drizzle-kit',
  'generate',
  '--output',
  'json',
  '--config',
  config,
  '--explain',
]);
if (drift.status === 'ok') {
  fail(
    'Drizzle schema drift detected. Run `npm run db:generate -- --name <name>` and commit the migration.',
    drift,
  );
}
if (drift.status !== 'no_changes') {
  fail('Drizzle schema drift check failed.', drift);
}

console.log('App database migrations are current.');

function runJson(label, args) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  const stdout = result.stdout.trim();
  if (result.status !== 0 && !stdout) {
    fail(`${label} exited ${result.status ?? 'without status'}.`, {
      stderr: result.stderr.trim(),
    });
  }

  try {
    const envelope = JSON.parse(stdout);
    if (result.status !== 0) {
      fail(`${label} exited ${result.status}.`, envelope);
    }
    return envelope;
  } catch {
    fail(`${label} did not return JSON.`, {
      stdout,
      stderr: result.stderr.trim(),
    });
  }
}

function fail(message, details) {
  console.error(message);
  console.error(JSON.stringify(details, null, 2));
  process.exit(1);
}
