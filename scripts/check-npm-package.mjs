import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const failures = [];

expect(packageJson.private !== true, 'package.json must not be private.');
expect(packageJson.name === 'neondeck', 'package name must be neondeck.');
expect(
  packageJson.bin?.neondeck === 'bin/neondeck.mjs',
  'package must expose the neondeck CLI binary.',
);
expect(packageJson.license === 'MIT', 'package license must be MIT.');
expect(
  packageJson.main === undefined,
  'CLI package must not point main at a missing module.',
);
expect(
  packageJson.repository?.url ===
    'git+https://github.com/pandemicsyn/neondeck.git',
  'package repository URL must match the public GitHub repository.',
);
expect(
  packageJson.publishConfig?.registry === 'https://registry.npmjs.org/',
  'publishConfig.registry must point at npmjs.',
);
expect(
  packageJson.publishConfig?.access === 'public',
  'publishConfig.access must be public.',
);
expect(
  packageJson.publishConfig?.provenance === true,
  'publishConfig.provenance must stay enabled.',
);

const pack = run('npm', ['pack', '--dry-run', '--json']);
const packOutput = parsePackOutput(pack.stdout);
const files = new Set(packOutput.files.map((file) => file.path));

for (const requiredPath of [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'SOUL.md',
  'bin/neondeck.mjs',
  'config/dashboard.json',
  'config/dashboard.schema.json',
  'dist/server.mjs',
  'web/dist/index.html',
  'web/dist/manifest.webmanifest',
  'drizzle.config.ts',
  'src/cli/index.ts',
  'src/runtime-home/app-db/migrations/20260704065926_baseline/migration.sql',
  'src/runtime-home/app-db/migrations/20260704065926_baseline/snapshot.json',
  'src/skills/neondeck/SKILL.md',
  'src/skills/neondeck-handoff/SKILL.md',
]) {
  expect(files.has(requiredPath), `packed package is missing ${requiredPath}.`);
}

const forbiddenPatterns = [
  /^\.env(?:\.|$)/,
  /^\.github\//,
  /^\.plans\//,
  /^\.release\//,
  /^design\//,
  /^docs\//,
  /^node_modules\//,
  /^raycast\//,
  /^research-repos\//,
  /^web\/(?!dist\/)/,
  /(^|\/)\.DS_Store$/,
  /(^|\/).*\.test\.tsx?$/,
  /^src\/test-setup\.ts$/,
  /^vitest\./,
];

for (const file of files) {
  for (const pattern of forbiddenPatterns) {
    expect(!pattern.test(file), `packed package must not include ${file}.`);
  }
}

if (failures.length > 0) {
  console.error('npm package check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `npm package check passed: ${packOutput.filename} contains ${packOutput.entryCount} files.`,
);

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function parsePackOutput(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`npm pack did not emit JSON output:\n${stdout}`);
  }

  const parsed = JSON.parse(stdout.slice(start, end + 1));
  const [packOutput] = parsed;
  if (!packOutput || !Array.isArray(packOutput.files)) {
    throw new Error('npm pack JSON output did not include a files array.');
  }
  return packOutput;
}

function run(command, args) {
  const result = spawnSync(command, args, {
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
