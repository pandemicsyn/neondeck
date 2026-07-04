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
const sourceRoots = ['src', 'web/src'];
const sourceExtensions = new Set(['.ts', '.tsx']);

const backendLayers = new Map([
  ['src/lib', 0],
  ['src/runtime-home', 1],
  ['src/repo-edit', 2],
  ['src/sandboxes', 2],
  ['src/modules/github', 2],
  ['src/modules/worktrees', 2],
  ['src/modules/sessions', 2],
  ['src/modules/repos', 2],
  ['src/modules/safety', 2],
  ['src/modules/memory', 2],
  ['src/modules/config', 3],
  ['src/modules/execution', 3],
  ['src/modules/kilo', 3],
  ['src/modules/watches', 3],
  ['src/modules/scheduler', 3],
  ['src/modules/prepared-diffs', 3],
  ['src/modules/pr-events', 3],
  ['src/modules/autopilot', 4],
  ['src/modules/learning', 4],
  ['src/modules/commands', 4],
  ['src/server', 5],
  ['src/cli', 5],
  ['src/workflows', 5],
  ['src/agents', 5],
  ['src/skills', 5],
]);

const compatibilityShimLayers = new Map([
  ['src/agent-config.ts', 2],
  ['src/app.ts', 5],
  ['src/app-state.ts', 1],
  ['src/autonomous-audit.ts', 4],
  ['src/autopilot.ts', 4],
  ['src/autopilot-notifications.ts', 4],
  ['src/autopilot-policy.ts', 4],
  ['src/autopilot-recovery.ts', 4],
  ['src/autopilot-workflows.ts', 4],
  ['src/commands.ts', 4],
  ['src/config-actions.ts', 3],
  ['src/config-events.ts', 3],
  ['src/db.ts', 1],
  ['src/dev-doctor.ts', 4],
  ['src/env.ts', 1],
  ['src/exedev-checkouts.ts', 3],
  ['src/exedev-context.ts', 3],
  ['src/execution.ts', 3],
  ['src/execution-actions.ts', 3],
  ['src/execution-policy.ts', 3],
  ['src/github-actions.ts', 2],
  ['src/github.ts', 2],
  ['src/kilo-actions.ts', 3],
  ['src/kilo-notifications.ts', 3],
  ['src/kilo-results.ts', 3],
  ['src/kilo-task-store.ts', 3],
  ['src/learning-operator.ts', 4],
  ['src/learning-reviews.ts', 4],
  ['src/local-api-auth.ts', 4],
  ['src/memory.ts', 2],
  ['src/memory-actions.ts', 2],
  ['src/metrics.ts', 5],
  ['src/model-discovery.ts', 2],
  ['src/native-notifications.ts', 1],
  ['src/notification-events.ts', 1],
  ['src/prepared-diffs.ts', 3],
  ['src/pr-event-state.ts', 3],
  ['src/providers.ts', 3],
  ['src/repos.ts', 2],
  ['src/runtime-home.ts', 1],
  ['src/runtime-skills.ts', 2],
  ['src/runtime-status.ts', 4],
  ['src/safety.ts', 2],
  ['src/scheduler.ts', 3],
  ['src/session-actions.ts', 2],
  ['src/session-events.ts', 2],
  ['src/sessions.ts', 2],
  ['src/skill-patches.ts', 4],
  ['src/soul.ts', 5],
  ['src/subagents.ts', 5],
  ['src/tools.ts', 5],
  ['src/utility-model.ts', 2],
  ['src/watch-actions.ts', 3],
  ['src/workflow-observability.ts', 5],
  ['src/worktrees.ts', 2],
]);

const allowedLayerBridges = new Set([
  'src/modules/kilo/results/gates.ts -> src/autopilot-policy.ts',
  'src/modules/kilo/results/service.ts -> src/autopilot-policy.ts',
  'src/modules/kilo/results/service.ts -> src/autopilot-workflows.ts',
  'src/modules/kilo/results/state.ts -> src/autopilot-policy.ts',
  'src/modules/prepared-diffs/schemas.ts -> src/autonomous-audit.ts',
  'src/modules/prepared-diffs/service.ts -> src/autonomous-audit.ts',
  'src/modules/prepared-diffs/store.ts -> src/autonomous-audit.ts',
  'src/modules/safety/service.ts -> src/execution-policy.ts',
  'src/modules/scheduler/dispatch.ts -> src/workflows/briefing.ts',
  'src/modules/scheduler/dispatch.ts -> src/workflows/command-run.ts',
  'src/modules/worktrees/service.ts -> src/prepared-diffs.ts',
]);

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
