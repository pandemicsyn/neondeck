import {
  defineAction,
  defineSkill,
  type JsonValue,
  type SkillReference,
} from '@flue/runtime';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  ensureRuntimeHomeSync,
  parseAppConfig,
  readRuntimeJson,
  readRuntimeJsonSync,
  runtimePaths,
} from './runtime-home';

type RuntimeSkillSource = 'built-in' | 'user' | 'external';

type RuntimeSkillRoot = {
  path: string;
  source: RuntimeSkillSource;
};

type RuntimeSkillCandidate = {
  id: string;
  description: string;
  path: string;
  directory: string;
  root: string;
  source: RuntimeSkillSource;
};

export type RuntimeSkillMetadata = RuntimeSkillCandidate & {
  status: 'active' | 'duplicate';
};

export type IgnoredRuntimeSkill = {
  path: string;
  root: string;
  source: RuntimeSkillSource;
  reason: string;
};

export type RuntimeSkillDuplicate = {
  id: string;
  paths: string[];
};

export type RuntimeSkillInventory = {
  roots: RuntimeSkillRoot[];
  skills: RuntimeSkillMetadata[];
  duplicates: RuntimeSkillDuplicate[];
  ignored: IgnoredRuntimeSkill[];
  loadedAt: string;
};

export type LoadedRuntimeSkill = RuntimeSkillMetadata & {
  content: string;
};

type RuntimeSkillActionResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  skills?: JsonValue[];
  skill?: JsonValue;
  roots?: JsonValue[];
  duplicates?: JsonValue[];
  ignored?: JsonValue[];
  errors?: string[];
  requires?: string[];
};

const skillNameSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);
const skillLoadInputSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
});
const runtimeSkillActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});
const maxSkillResourceBytes = 256 * 1024;
const sensitiveSkillResourceNames = new Set([
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);
const applicationSkillPath = fileURLToPath(
  new URL('./skills/neondeck/SKILL.md', import.meta.url),
);

export const skillsListAction = defineAction({
  name: 'neondeck_skills_list',
  description:
    'List discovered Neondeck runtime skills, ignored skill folders, and duplicate skill ids.',
  input: v.object({}),
  output: runtimeSkillActionOutputSchema,
  async run() {
    return listRuntimeSkillsAction();
  },
});

export const skillLoadAction = defineAction({
  name: 'neondeck_skill_load',
  description:
    'Load the full SKILL.md content for one active Neondeck runtime skill by id.',
  input: skillLoadInputSchema,
  output: runtimeSkillActionOutputSchema,
  async run({ input }) {
    return loadRuntimeSkillAction(input);
  },
});

export const skillsReloadAction = defineAction({
  name: 'neondeck_skills_reload',
  description:
    'Rescan Neondeck runtime skill metadata from disk and report validation issues. Agent behavior uses Flue skills and may require a new session or server restart.',
  input: v.object({}),
  output: runtimeSkillActionOutputSchema,
  async run() {
    return reloadRuntimeSkillsAction();
  },
});

export const neondeckRuntimeSkillActions = [skillsReloadAction];

export async function listRuntimeSkills(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const roots = await runtimeSkillRootsSafe(paths);
  return discoverRuntimeSkills(paths, roots.roots, roots.ignored);
}

export async function loadRuntimeSkill(
  input: v.InferInput<typeof skillLoadInputSchema>,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(skillLoadInputSchema, input);
  if (!parsed.success) {
    return {
      ok: false as const,
      error: 'Invalid skill load input.',
      issues: [v.summarize(parsed.issues)],
    };
  }

  const inventory = await listRuntimeSkills(paths);
  const matches = inventory.skills.filter(
    (skill) => skill.id === parsed.output.id,
  );
  const active = matches.find((skill) => skill.status === 'active');
  if (!active) {
    const duplicate = inventory.duplicates.find(
      (entry) => entry.id === parsed.output.id,
    );
    return {
      ok: false as const,
      error: duplicate
        ? `Skill "${parsed.output.id}" is duplicated and cannot be loaded until duplicates are resolved.`
        : `Skill "${parsed.output.id}" is not available.`,
      requires: duplicate ? ['resolveDuplicateSkill'] : ['id'],
      inventory,
    };
  }

  return {
    ok: true as const,
    skill: {
      ...active,
      content: await readFile(active.path, 'utf8'),
    },
    inventory,
  };
}

export async function reloadRuntimeSkills(paths = runtimePaths()) {
  return listRuntimeSkills(paths);
}

export function runtimeSkillReferencesSync(
  paths = runtimePaths(),
): SkillReference[] {
  ensureRuntimeHomeSync(paths);
  const roots = runtimeSkillRootsSafeSync(paths);
  const inventory = discoverRuntimeSkillsSync(
    paths,
    roots.roots,
    roots.ignored,
  );
  return inventory.skills
    .filter((skill) => skill.status === 'active' && skill.source !== 'built-in')
    .map((skill) => runtimeSkillReference(skill));
}

async function listRuntimeSkillsAction(
  paths = runtimePaths(),
): Promise<RuntimeSkillActionResult> {
  const inventory = await listRuntimeSkills(paths);
  return okResult('skills_list', 'Listed runtime skills.', inventory);
}

async function loadRuntimeSkillAction(
  input: v.InferInput<typeof skillLoadInputSchema>,
  paths = runtimePaths(),
): Promise<RuntimeSkillActionResult> {
  const result = await loadRuntimeSkill(input, paths);
  if (!result.ok) {
    return {
      ok: false,
      action: 'skill_load',
      changed: false,
      message: result.error,
      ...(result.requires ? { requires: result.requires } : {}),
      ...(result.issues ? { errors: result.issues } : {}),
      ...(result.inventory
        ? {
            skills: result.inventory.skills.map(asJsonValue),
            duplicates: result.inventory.duplicates.map(asJsonValue),
            ignored: result.inventory.ignored.map(asJsonValue),
          }
        : {}),
    };
  }

  return okResult('skill_load', `Loaded runtime skill "${result.skill.id}".`, {
    ...result.inventory,
    skills: result.inventory.skills,
    skill: result.skill,
  });
}

async function reloadRuntimeSkillsAction(
  paths = runtimePaths(),
): Promise<RuntimeSkillActionResult> {
  const inventory = await reloadRuntimeSkills(paths);
  return okResult('skills_reload', 'Reloaded runtime skills.', inventory);
}

async function runtimeSkillRoots(paths: RuntimePaths) {
  const config = await readRuntimeJson(paths.config, parseAppConfig);
  return buildRuntimeSkillRoots(paths, config.skillRoots ?? []);
}

function runtimeSkillRootsSync(paths: RuntimePaths) {
  const config = readRuntimeJsonSync(paths.config, parseAppConfig);
  return buildRuntimeSkillRoots(paths, config.skillRoots ?? []);
}

async function runtimeSkillRootsSafe(paths: RuntimePaths) {
  try {
    return {
      roots: await runtimeSkillRoots(paths),
      ignored: [] as IgnoredRuntimeSkill[],
    };
  } catch (error) {
    return {
      roots: buildRuntimeSkillRoots(paths, []),
      ignored: [ignoredConfig(paths, errorMessage(error))],
    };
  }
}

function runtimeSkillRootsSafeSync(paths: RuntimePaths) {
  try {
    return {
      roots: runtimeSkillRootsSync(paths),
      ignored: [] as IgnoredRuntimeSkill[],
    };
  } catch (error) {
    return {
      roots: buildRuntimeSkillRoots(paths, []),
      ignored: [ignoredConfig(paths, errorMessage(error))],
    };
  }
}

function buildRuntimeSkillRoots(paths: RuntimePaths, externalRoots: string[]) {
  return [
    { path: paths.skills, source: 'user' as const },
    ...externalRoots.map((root) => ({
      path: expandRuntimePath(root),
      source: 'external' as const,
    })),
  ];
}

async function discoverRuntimeSkills(
  paths: RuntimePaths,
  roots: RuntimeSkillRoot[],
  initialIgnored: IgnoredRuntimeSkill[] = [],
): Promise<RuntimeSkillInventory> {
  const candidates: RuntimeSkillCandidate[] = [];
  const ignored: IgnoredRuntimeSkill[] = [...initialIgnored];
  const builtIn = readApplicationSkillCandidate();
  if (builtIn.ok) {
    candidates.push(builtIn.skill);
  } else {
    ignored.push(builtIn.ignored);
  }

  for (const root of roots) {
    const entries = await readSkillRoot(root);
    for (const entry of entries.ignored) ignored.push(entry);
    for (const directory of entries.directories) {
      const source = runtimeSkillSource(paths, root, directory);
      const candidate = await readSkillCandidate(directory, root, source);
      if (candidate.ok) {
        candidates.push(candidate.skill);
      } else {
        ignored.push(candidate.ignored);
      }
    }
  }

  return buildInventory(roots, candidates, ignored);
}

function discoverRuntimeSkillsSync(
  paths: RuntimePaths,
  roots: RuntimeSkillRoot[],
  initialIgnored: IgnoredRuntimeSkill[] = [],
) {
  const candidates: RuntimeSkillCandidate[] = [];
  const ignored: IgnoredRuntimeSkill[] = [...initialIgnored];

  const builtIn = readApplicationSkillCandidate();
  if (builtIn.ok) {
    candidates.push(builtIn.skill);
  } else {
    ignored.push(builtIn.ignored);
  }

  for (const root of roots) {
    const entries = readSkillRootSync(root);
    for (const entry of entries.ignored) ignored.push(entry);
    for (const directory of entries.directories) {
      const source = runtimeSkillSource(paths, root, directory);
      const candidate = readSkillCandidateSync(directory, root, source);
      if (candidate.ok) {
        candidates.push(candidate.skill);
      } else {
        ignored.push(candidate.ignored);
      }
    }
  }

  return buildInventory(roots, candidates, ignored);
}

function readApplicationSkillCandidate() {
  return parseSkillFile(
    readFileSync(applicationSkillPath, 'utf8'),
    applicationSkillPath,
    { path: dirname(dirname(applicationSkillPath)), source: 'built-in' },
    'built-in',
  );
}

async function readSkillRoot(root: RuntimeSkillRoot) {
  try {
    const rootStat = await stat(root.path);
    if (!rootStat.isDirectory()) {
      return {
        directories: [],
        ignored: [ignoredRoot(root, 'Skill root is not a directory.')],
      };
    }

    const entries = await readdir(root.path, { withFileTypes: true });
    return {
      directories: entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root.path, entry.name)),
      ignored: [] as IgnoredRuntimeSkill[],
    };
  } catch {
    return {
      directories: [],
      ignored: [ignoredRoot(root, 'Skill root is not readable.')],
    };
  }
}

function readSkillRootSync(root: RuntimeSkillRoot) {
  try {
    const rootStat = statSync(root.path);
    if (!rootStat.isDirectory()) {
      return {
        directories: [],
        ignored: [ignoredRoot(root, 'Skill root is not a directory.')],
      };
    }

    return {
      directories: readdirSync(root.path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root.path, entry.name)),
      ignored: [] as IgnoredRuntimeSkill[],
    };
  } catch {
    return {
      directories: [],
      ignored: [ignoredRoot(root, 'Skill root is not readable.')],
    };
  }
}

async function readSkillCandidate(
  directory: string,
  root: RuntimeSkillRoot,
  source: RuntimeSkillSource,
) {
  const skillPath = join(directory, 'SKILL.md');
  if (!existsSync(skillPath)) {
    return {
      ok: false as const,
      ignored: ignoredSkill(skillPath, root, source, 'Missing SKILL.md.'),
    };
  }

  try {
    return parseSkillFile(
      await readFile(skillPath, 'utf8'),
      skillPath,
      root,
      source,
    );
  } catch (error) {
    return {
      ok: false as const,
      ignored: ignoredSkill(skillPath, root, source, errorMessage(error)),
    };
  }
}

function readSkillCandidateSync(
  directory: string,
  root: RuntimeSkillRoot,
  source: RuntimeSkillSource,
) {
  const skillPath = join(directory, 'SKILL.md');
  if (!existsSync(skillPath)) {
    return {
      ok: false as const,
      ignored: ignoredSkill(skillPath, root, source, 'Missing SKILL.md.'),
    };
  }

  try {
    return parseSkillFile(
      readFileSync(skillPath, 'utf8'),
      skillPath,
      root,
      source,
    );
  } catch (error) {
    return {
      ok: false as const,
      ignored: ignoredSkill(skillPath, root, source, errorMessage(error)),
    };
  }
}

function parseSkillFile(
  source: string,
  path: string,
  root: RuntimeSkillRoot,
  skillSource: RuntimeSkillSource,
):
  | { ok: true; skill: RuntimeSkillCandidate }
  | { ok: false; ignored: IgnoredRuntimeSkill } {
  const metadata = parseFrontmatter(source);
  if (!metadata.ok) {
    return {
      ok: false,
      ignored: ignoredSkill(path, root, skillSource, metadata.reason),
    };
  }

  const nameResult = v.safeParse(skillNameSchema, metadata.data.name);
  if (!nameResult.success) {
    return {
      ok: false,
      ignored: ignoredSkill(
        path,
        root,
        skillSource,
        'Skill frontmatter name must be lowercase letters, numbers, and hyphens.',
      ),
    };
  }

  const expectedName = basename(resolve(path, '..'));
  if (nameResult.output !== expectedName) {
    return {
      ok: false,
      ignored: ignoredSkill(
        path,
        root,
        skillSource,
        `Skill name "${nameResult.output}" must match directory "${expectedName}".`,
      ),
    };
  }

  if (skillSource !== 'built-in' && nameResult.output === 'neondeck') {
    return {
      ok: false,
      ignored: ignoredSkill(
        path,
        root,
        skillSource,
        'Skill id "neondeck" is reserved for the built-in application Flue skill.',
      ),
    };
  }

  if (
    typeof metadata.data.description !== 'string' ||
    metadata.data.description.trim().length === 0 ||
    metadata.data.description.length > 1024
  ) {
    return {
      ok: false,
      ignored: ignoredSkill(
        path,
        root,
        skillSource,
        'Skill frontmatter description must be non-empty and at most 1024 characters.',
      ),
    };
  }

  return {
    ok: true,
    skill: {
      id: nameResult.output,
      description: metadata.data.description.trim(),
      path,
      directory: resolve(path, '..'),
      root: root.path,
      source: skillSource,
    },
  };
}

function parseFrontmatter(
  source: string,
):
  | { ok: true; data: Record<string, string>; body: string }
  | { ok: false; reason: string } {
  if (!source.startsWith('---\n')) {
    return { ok: false, reason: 'Missing YAML frontmatter.' };
  }

  const end = source.indexOf('\n---', 4);
  if (end === -1) {
    return { ok: false, reason: 'Unclosed YAML frontmatter.' };
  }

  const metadata: Record<string, string> = {};
  for (const line of source.slice(4, end).split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    metadata[match[1]] = unquoteYamlScalar(match[2].trim());
  }

  return { ok: true, data: metadata, body: source.slice(end + 4).trimStart() };
}

function unquoteYamlScalar(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function buildInventory(
  roots: RuntimeSkillRoot[],
  candidates: RuntimeSkillCandidate[],
  ignored: IgnoredRuntimeSkill[],
): RuntimeSkillInventory {
  const byId = new Map<string, RuntimeSkillCandidate[]>();
  for (const candidate of candidates) {
    byId.set(candidate.id, [...(byId.get(candidate.id) ?? []), candidate]);
  }

  const duplicates = Array.from(byId.entries())
    .filter(([, skills]) => skills.length > 1)
    .map(([id, skills]) => ({ id, paths: skills.map((skill) => skill.path) }));
  const duplicateIds = new Set(duplicates.map((duplicate) => duplicate.id));
  const skills = candidates
    .map((skill) => ({
      ...skill,
      status: duplicateIds.has(skill.id)
        ? ('duplicate' as const)
        : ('active' as const),
    }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));

  return {
    roots,
    skills,
    duplicates,
    ignored,
    loadedAt: new Date().toISOString(),
  };
}

function runtimeSkillSource(
  paths: RuntimePaths,
  root: RuntimeSkillRoot,
  _directory: string,
): RuntimeSkillSource {
  if (root.source === 'external') return 'external';
  return 'user';
}

function ignoredRoot(
  root: RuntimeSkillRoot,
  reason: string,
): IgnoredRuntimeSkill {
  return {
    path: root.path,
    root: root.path,
    source: root.source,
    reason,
  };
}

function ignoredConfig(
  paths: RuntimePaths,
  reason: string,
): IgnoredRuntimeSkill {
  return {
    path: paths.config,
    root: paths.home,
    source: 'user',
    reason,
  };
}

function ignoredSkill(
  path: string,
  root: RuntimeSkillRoot,
  source: RuntimeSkillSource,
  reason: string,
): IgnoredRuntimeSkill {
  return {
    path,
    root: root.path,
    source,
    reason,
  };
}

function okResult(
  action: string,
  message: string,
  inventory: RuntimeSkillInventory & { skill?: LoadedRuntimeSkill },
): RuntimeSkillActionResult {
  return {
    ok: true,
    action,
    changed: false,
    message,
    roots: inventory.roots.map(asJsonValue),
    skills: inventory.skills.map(asJsonValue),
    duplicates: inventory.duplicates.map(asJsonValue),
    ignored: inventory.ignored.map(asJsonValue),
    ...(inventory.skill ? { skill: asJsonValue(inventory.skill) } : {}),
  };
}

function expandRuntimePath(path: string) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(path);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function runtimeSkillReference(skill: RuntimeSkillMetadata): SkillReference {
  const source = readFileSync(skill.path, 'utf8');
  const metadata = parseFrontmatter(source);
  const files = collectSupportingFilesSync(skill.directory);

  return defineSkill({
    name: skill.id,
    description: skill.description,
    instructions: metadata.ok ? metadata.body : source,
    files,
  });
}

function collectSupportingFilesSync(directory: string) {
  const files: Record<string, string | Uint8Array> = {};
  collectSupportingFilesInto(directory, directory, files);
  return files;
}

function collectSupportingFilesInto(
  root: string,
  directory: string,
  files: Record<string, string | Uint8Array>,
) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      collectSupportingFilesInto(root, path, files);
      continue;
    }

    if (!entry.isFile() || entry.name === 'SKILL.md') continue;

    const relativePath = relative(root, path);
    if (isSensitiveSkillResource(relativePath)) continue;

    const resource = readFileSync(path);
    if (resource.byteLength > maxSkillResourceBytes) continue;

    files[relativePath] = isUtf8Text(resource)
      ? resource.toString('utf8')
      : new Uint8Array(resource);
  }
}

function isSensitiveSkillResource(path: string) {
  const normalized = path.toLowerCase();
  const name = basename(normalized);
  return (
    sensitiveSkillResourceNames.has(name) ||
    normalized.endsWith('.pem') ||
    normalized.endsWith('.key') ||
    normalized.endsWith('.p12') ||
    normalized.endsWith('.pfx') ||
    normalized.includes('secret') ||
    normalized.includes('token') ||
    normalized.includes('credential')
  );
}

function isUtf8Text(buffer: Buffer) {
  return buffer.toString('utf8').indexOf('\uFFFD') === -1;
}
