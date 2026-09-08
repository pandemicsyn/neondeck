import { constants } from 'node:fs';
import { satisfies } from 'semver';
import { realpath, stat, access } from 'node:fs/promises';
import { relative, resolve, sep, join, dirname, isAbsolute } from 'node:path';
import * as v from 'valibot';
import {
  repoWorkflowProfileSchema,
  repoWorkflowCwdSchema,
} from '../../../shared/repo-workflows';

const executableSchema = v.strictObject({
  path: v.pipe(v.string(), v.check(isAbsolute)),
  size: v.number(),
  mtimeMs: v.number(),
  mode: v.number(),
});
export const workflowToolchainSchema = v.strictObject({
  packageManager: v.nullable(executableSchema),
  tools: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          name: v.picklist(['npm', 'npx', 'pnpm', 'yarn', 'bun']),
          executable: executableSchema,
        }),
      ),
      v.maxLength(5),
    ),
  ),
});
export type WorkflowToolchain = v.InferOutput<typeof workflowToolchainSchema>;
export class WorkflowRuntimeUnavailableError extends Error {}
export async function discoverWorkflowToolchain(
  runtime: v.InferOutput<typeof repoWorkflowProfileSchema>['runtime'],
  searchPath = process.env.PATH ?? '',
): Promise<WorkflowToolchain> {
  v.parse(repoWorkflowProfileSchema.entries.runtime, runtime);
  const directories = [
    ...new Set([
      dirname(process.execPath),
      ...searchPath.split(':').filter(isAbsolute),
      '/usr/bin',
      '/bin',
    ]),
  ].slice(0, 128);
  const tools: NonNullable<WorkflowToolchain['tools']> = [];
  for (const name of ['npm', 'npx', 'pnpm', 'yarn', 'bun'] as const) {
    for (const directory of directories) {
      try {
        const path = await realpath(join(directory, name));
        await access(path, constants.X_OK);
        const metadata = await stat(path);
        if (!metadata.isFile()) continue;
        tools.push({
          name,
          executable: {
            path,
            size: metadata.size,
            mtimeMs: metadata.mtimeMs,
            mode: metadata.mode,
          },
        });
        break;
      } catch {
        /* Bounded filesystem discovery; never inherit operator PATH or execute startup files. */
      }
    }
  }
  return {
    packageManager:
      tools.find((tool) => tool.name === runtime.packageManager?.name)
        ?.executable ?? null,
    tools,
  };
}

/** Presence preflight only; the supervised worker checks the selected tool's actual version. */
export async function preflightRepoWorkflowRuntime(raw: unknown) {
  const workflow = v.parse(repoWorkflowProfileSchema, raw);
  workflowEnvironmentValues(workflow.environmentRefs);
  if (
    workflow.runtime.node &&
    !runtimeVersionMatches(process.version, workflow.runtime.node)
  )
    throw new WorkflowRuntimeUnavailableError(
      `ENVIRONMENT SETUP: Node ${workflow.runtime.node} is required; the available runtime is ${process.version}.`,
    );
  const toolchain = await discoverWorkflowToolchain(workflow.runtime);
  if (workflow.runtime.packageManager && !toolchain.packageManager)
    throw new WorkflowRuntimeUnavailableError(
      `ENVIRONMENT SETUP: ${workflow.runtime.packageManager.name}${workflow.runtime.packageManager.version ? ` ${workflow.runtime.packageManager.version}` : ''} is required but its executable is unavailable.`,
    );
  return toolchain;
}
export async function assertWorkflowToolchain(input: WorkflowToolchain) {
  const toolchain = v.parse(workflowToolchainSchema, input);
  for (const { name, executable: expected } of [
    ...(toolchain.packageManager
      ? [
          {
            name: 'selected package manager',
            executable: toolchain.packageManager,
          },
        ]
      : []),
    ...(toolchain.tools ?? []),
  ]) {
    const actual = await stat(expected.path);
    if (
      (await realpath(expected.path)) !== expected.path ||
      !actual.isFile() ||
      actual.size !== expected.size ||
      actual.mtimeMs !== expected.mtimeMs ||
      actual.mode !== expected.mode
    )
      throw new WorkflowRuntimeUnavailableError(
        `ENVIRONMENT SETUP: ${name} changed after preflight; retry with the available toolchain.`,
      );
  }
  return toolchain;
}
export const workflowExecutionSchema = v.strictObject({
  root: v.pipe(v.string(), v.minLength(1), v.check(isAbsolute)),
  toolchain: v.optional(workflowToolchainSchema),
  runtime: repoWorkflowProfileSchema.entries.runtime,
  environmentRefs: repoWorkflowProfileSchema.entries.environmentRefs,
});
/** Runtime values are execution-private: never serialize this return value. */
export function workflowEnvironmentValues(
  refs: string[],
  source = process.env,
) {
  v.parse(repoWorkflowProfileSchema.entries.environmentRefs, refs);
  const values: Record<string, string> = {};
  for (const name of refs) {
    const value = source[name];
    if (!value || value.length > 65536 || value.includes('\0'))
      throw new WorkflowRuntimeUnavailableError(
        `ENVIRONMENT SETUP: required reference ${name} is unavailable.`,
      );
    values[name] = value;
  }
  return values;
}
export function redactWorkflowOutput(
  text: string,
  values: Record<string, string>,
) {
  const secrets = [
    ...new Set(
      Object.values(values).flatMap((value) => [
        value,
        JSON.stringify(value).slice(1, -1),
        encodeURIComponent(value),
        Buffer.from(value).toString('base64'),
      ]),
    ),
  ].sort((a, b) => b.length - a.length);
  for (const secret of secrets)
    if (secret) text = text.replaceAll(secret, '[REDACTED]');
  return text;
}
export async function workflowCommandCwd(root: string, cwd: string) {
  v.parse(repoWorkflowCwdSchema, cwd);
  const canonical = await realpath(root);
  if (canonical !== root)
    throw new Error('Workflow checkout must be canonical.');
  const path = await realpath(resolve(root, cwd));
  const child = relative(root, path);
  if (
    child === '..' ||
    child.startsWith(`..${sep}`) ||
    !(await stat(path)).isDirectory()
  )
    throw new Error('Workflow command directory escapes its owned checkout.');
  return path;
}
export function runtimeVersionMatches(version: string, requirement: string) {
  return satisfies(version.trim(), requirement);
}
