import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import {
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoots = ['src', 'web/src', 'shared'];
const sourceExtensions = new Set(['.ts', '.tsx']);

const backendLayers = new Map([
  ['src/lib', 0],
  ['src/runtime-home', 1],
  ['src/modules/app-state', 2],
  ['src/modules/runtime', 2],
  ['src/modules/autonomous-audit', 2],
  ['src/repo-edit', 2],
  ['src/sandboxes', 2],
  ['src/modules/github', 2],
  ['src/modules/worktrees', 2],
  ['src/modules/sessions', 2],
  ['src/modules/repos', 2],
  ['src/modules/safety', 2],
  ['src/modules/memory', 2],
  ['src/modules/prepared-diffs', 2],
  ['src/modules/execution-policy', 2],
  ['src/modules/config', 3],
  ['src/modules/execution', 3],
  ['src/modules/kilo', 3],
  ['src/modules/watches', 3],
  ['src/modules/pr-events', 3],
  ['src/modules/reports', 3],
  ['src/modules/autopilot-policy', 3],
  ['src/modules/worktree-verification', 3],
  ['src/modules/autopilot', 4],
  ['src/modules/pr-review-assist', 4],
  ['src/modules/learning', 4],
  ['src/modules/scheduler', 5],
  ['src/modules/commands', 5],
  ['src/server', 5],
  ['src/cli', 5],
  ['src/workflows', 5],
  ['src/agents', 5],
  ['src/skills', 5],
]);

const compatibilityShimLayers = new Map([
  ['src/app.ts', 5],
  ['src/db.ts', 1],
]);

const allowedLayerBridges = new Set([]);

const frontendApiHelperImports = new Set(['web/src/lib/query.ts']);

const importPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gms;

const files = sourceRoots.flatMap((sourceRoot) =>
  walk(join(root, sourceRoot)).filter((file) =>
    sourceExtensions.has(extname(file)),
  ),
);
const violations = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    if (!specifier?.startsWith('.')) continue;

    const target = resolveImport(dirname(file), specifier);
    if (!target) continue;

    const sourceRel = normalize(relative(root, file));
    const targetRel = normalize(relative(root, target));
    if (sourceRel.startsWith('src/')) {
      checkBackendImport(sourceRel, targetRel);
    } else if (sourceRel.startsWith('web/src/')) {
      checkFrontendImport(sourceRel, targetRel);
    } else if (sourceRel.startsWith('shared/')) {
      checkSharedImport(sourceRel, targetRel);
    }
  }
}

if (violations.length > 0) {
  console.error('Import layer violations found:');
  for (const violation of violations) {
    console.error(`- ${violation.source} imports ${violation.target}`);
    console.error(`  ${violation.reason}`);
  }
  process.exit(1);
}

console.log('Import layer check passed.');

function walk(directory) {
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    if (entry.isFile()) return [path];
    return [];
  });
}

function resolveImport(fromDirectory, specifier) {
  const base = resolve(fromDirectory, specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];

  return candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
}

function checkBackendImport(sourceRel, targetRel) {
  if (targetRel.startsWith('shared/')) return;
  if (!targetRel.startsWith('src/')) {
    violations.push({
      source: sourceRel,
      target: targetRel,
      reason: 'backend modules must not import frontend modules',
    });
    return;
  }
  if (allowedLayerBridges.has(`${sourceRel} -> ${targetRel}`)) return;

  const sourceLayer = backendLayerFor(sourceRel);
  const targetLayer = backendLayerFor(targetRel);
  if (sourceLayer === undefined || targetLayer === undefined) return;
  if (targetLayer > sourceLayer) {
    violations.push({
      source: sourceRel,
      target: targetRel,
      reason: `backend layer ${sourceLayer} cannot import higher layer ${targetLayer}`,
    });
  }

  const sourceModule = moduleName(sourceRel);
  const targetModule = moduleName(targetRel);
  if (
    sourceModule &&
    targetModule &&
    sourceModule !== targetModule &&
    targetRel !== `src/modules/${targetModule}/index.ts`
  ) {
    violations.push({
      source: sourceRel,
      target: targetRel,
      reason: `cross-module imports must use src/modules/${targetModule}/index.ts`,
    });
  }
}

function checkFrontendImport(sourceRel, targetRel) {
  if (targetRel.startsWith('shared/')) return;
  if (!targetRel.startsWith('web/src/')) {
    violations.push({
      source: sourceRel,
      target: targetRel,
      reason: 'frontend modules must not import backend modules',
    });
    return;
  }
  if (
    sourceRel.startsWith('web/src/api/') &&
    !targetRel.startsWith('web/src/api/') &&
    !frontendApiHelperImports.has(targetRel)
  ) {
    violations.push({
      source: sourceRel,
      target: targetRel,
      reason: 'frontend API modules must not import dashboard UI modules',
    });
  }
  if (
    sourceRel.startsWith('web/src/components/') &&
    (targetRel.startsWith('web/src/features/') ||
      targetRel.startsWith('web/src/plugins/'))
  ) {
    violations.push({
      source: sourceRel,
      target: targetRel,
      reason: 'shared components must not import feature or plugin modules',
    });
  }
  if (
    sourceRel.startsWith('web/src/lib/') &&
    (targetRel.startsWith('web/src/features/') ||
      targetRel.startsWith('web/src/plugins/') ||
      targetRel.startsWith('web/src/components/'))
  ) {
    violations.push({
      source: sourceRel,
      target: targetRel,
      reason:
        'frontend lib modules must stay below components, features, and plugins',
    });
  }
}

function checkSharedImport(sourceRel, targetRel) {
  if (!targetRel.startsWith('shared/')) {
    violations.push({
      source: sourceRel,
      target: targetRel,
      reason: 'shared modules must not import backend or frontend modules',
    });
  }
}

function backendLayerFor(path) {
  const shimLayer = compatibilityShimLayers.get(path);
  if (shimLayer !== undefined) return shimLayer;
  const exact = backendLayers.get(path);
  if (exact !== undefined) return exact;
  for (const [prefix, layer] of backendLayers) {
    if (path.startsWith(`${prefix}/`)) return layer;
  }
  return undefined;
}

function moduleName(path) {
  const match = /^src\/modules\/([^/]+)\//.exec(path);
  return match?.[1];
}
