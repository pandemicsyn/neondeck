import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const releaseRoot = join(root, '.release');
const packageJson = JSON.parse(
  await readText(new URL('../package.json', import.meta.url)),
);
const version = process.env.NEONDECK_RELEASE_VERSION || packageJson.version;
const packageName = `neondeck-${version}`;
const packageRoot = join(releaseRoot, packageName);
const archivePath = join(releaseRoot, `${packageName}.tar.gz`);
const checksumPath = `${archivePath}.sha256`;

for (const requiredPath of [
  'dist/server.mjs',
  'dist/assets',
  'web/dist/index.html',
  'web/dist/assets',
]) {
  if (!existsSync(join(root, requiredPath))) {
    throw new Error(`Missing build output: ${requiredPath}`);
  }
}

rmSync(releaseRoot, { recursive: true, force: true });
mkdirSync(packageRoot, { recursive: true });

copy('dist', 'dist');
copy('bin', 'bin');
copy('src', 'src');
copy('web/dist', 'web/dist');
copy('config', 'config');
copy('config', 'dist/config');
copy('src/skills', 'dist/assets/skills');
copyFile('SOUL.md', 'SOUL.md');
copyFile('SOUL.md', 'dist/SOUL.md');
copyFile('README.md', 'README.md');
copyFile('CHANGELOG.md', 'CHANGELOG.md');
copyFile('LICENSE', 'LICENSE');
copyFile('.env.example', '.env.example');
copyFile('.node-version', '.node-version');
writeRuntimePackageJson();
writeReleaseNotes();

execFileSync('tar', ['-czf', archivePath, '-C', releaseRoot, packageName], {
  cwd: root,
  stdio: 'inherit',
});

const checksum = createHash('sha256')
  .update(readFileSync(archivePath))
  .digest('hex');
writeFileSync(checksumPath, `${checksum}  ${packageName}.tar.gz\n`);

console.log(`Created ${archivePath}`);
console.log(`Created ${checksumPath}`);

async function readText(url) {
  const { readFile } = await import('node:fs/promises');
  return readFile(url, 'utf8');
}

function copy(from, to) {
  cpSync(join(root, from), join(packageRoot, to), { recursive: true });
}

function copyFile(from, to) {
  cpSync(join(root, from), join(packageRoot, to));
}

function writeRuntimePackageJson() {
  const runtimePackage = {
    name: packageJson.name,
    version,
    description: packageJson.description,
    homepage: packageJson.homepage,
    private: true,
    type: packageJson.type,
    engines: packageJson.engines,
    bin: packageJson.bin,
    scripts: {
      start: 'node dist/server.mjs',
    },
    dependencies: packageJson.dependencies,
  };

  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify(runtimePackage, null, 2)}\n`,
  );
}

function writeReleaseNotes() {
  writeFileSync(
    join(packageRoot, 'RELEASE.md'),
    `# neondeck ${version}

This archive contains the built Neondeck app only:

- \`dist/\`: built Node/Flue server and runtime resources
- \`bin/\`: package-local \`neondeck\` command shim
- \`src/\`: CLI source used by the command shim
- \`web/dist/\`: built local dashboard SPA
- \`config/\`, \`SOUL.md\`, and \`.env.example\`: default runtime setup files

Install production dependencies after unpacking:

\`\`\`sh
npm install --omit=dev
cp .env.example .env
npm start
\`\`\`

Or install the CLI from the unpacked archive:

\`\`\`sh
npm link
neondeck serve
\`\`\`

The Astro marketing/docs site is intentionally not included in this app release.
`,
  );
}
