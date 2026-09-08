import { requestFactoryWorkflowProposal } from './onboarding-factory-workflow-proposal';
import { loadEnvForPaths } from './options';
import { runFactoryWorkflowTrial } from './onboarding-factory-workflow-trial';
import { log, note } from '@clack/prompts';
import * as v from 'valibot';
import {
  repoWorkflowCommandSchema,
  repoWorkflowProfileSchema,
  repoFactoryWorkflowsSchema,
  type RepoFactoryWorkflows,
  type RepoWorkflowCommand,
  type RepoWorkflowProfile,
} from '../../shared/repo-workflows';
import {
  readRepoWorkflows,
  saveRepoWorkflows,
} from '../modules/repo-workflows';
import {
  parseRepoRegistry,
  readRuntimeJsonSync,
  type RuntimePaths,
} from '../runtime-home';
import { promptConfirm, promptSelect, promptText } from './prompts';

const validate = (schema: v.GenericSchema) => (value: string | undefined) =>
  v.safeParse(schema, value ?? '').success
    ? undefined
    : 'Enter a valid value for this field.';
async function commands(phase: string, current: RepoWorkflowCommand[]) {
  const result: RepoWorkflowCommand[] = [];
  for (let index = 0; index < 16; index++) {
    const existing = current[index];
    if (
      !existing &&
      !(await promptConfirm({
        message: `Add ${phase} command ${index + 1}?`,
        initialValue: false,
      }))
    )
      break;
    if (
      existing &&
      !(await promptConfirm({
        message: `Keep ${phase} command ${index + 1}: ${existing.command}?`,
        initialValue: true,
      }))
    )
      continue;
    const command = await promptText({
      message: `${phase} command ${index + 1} (one invocation; no shell script)`,
      initialValue: existing?.command ?? '',
      validate: validate(repoWorkflowCommandSchema.entries.command),
    });
    const cwd = await promptText({
      message: 'Working directory relative to repository (. for root)',
      initialValue: existing?.cwd ?? '.',
      validate: validate(repoWorkflowCommandSchema.entries.cwd),
    });
    result.push({ command, cwd });
  }
  return result;
}
export async function editFactoryWorkflowProfile(
  current: RepoWorkflowProfile,
  otherIds: string[] = [],
): Promise<RepoWorkflowProfile> {
  const id = await promptText({
    message: 'Workflow profile ID',
    initialValue: current.id,
    validate: (value) =>
      otherIds.includes(value?.trim() ?? '')
        ? 'Choose a unique profile ID.'
        : validate(repoWorkflowProfileSchema.entries.id)(value),
  });
  const name = await promptText({
    message: 'Workflow profile name',
    initialValue: current.name,
    validate: validate(repoWorkflowProfileSchema.entries.name),
  });
  const setupCommands = await commands('setup', current.setupCommands);
  const validationCommands = await commands(
    'check',
    current.validationCommands,
  );
  const timeout = async (phase: string, ms: number) =>
    Number(
      await promptText({
        message: `${phase} time limit in seconds (1–3600)`,
        initialValue: String(ms / 1000),
        validate: (value) =>
          /^\d+$/.test(value ?? '') &&
          Number(value) >= 1 &&
          Number(value) <= 3600
            ? undefined
            : 'Enter whole seconds from 1 to 3600.',
      }),
    ) * 1000;
  const setupTimeoutMs = await timeout('Setup', current.setupTimeoutMs);
  const validationTimeoutMs = await timeout(
    'Checks',
    current.validationTimeoutMs,
  );
  const node = await promptText({
    message: 'Node version requirement (optional, installed runtime only)',
    initialValue: current.runtime.node ?? '',
    validate: (value) =>
      !value?.trim() ||
      v.safeParse(
        repoWorkflowProfileSchema.entries.runtime.entries.node,
        value.trim(),
      ).success
        ? undefined
        : 'Enter a semantic version requirement, such as >=26.',
  });
  const packageName = await promptSelect({
    message: 'Package manager requirement',
    initialValue: current.runtime.packageManager?.name ?? 'none',
    options: ['none', 'npm', 'pnpm', 'yarn', 'bun'].map((value) => ({
      value,
      label: value === 'none' ? 'No requirement' : value,
    })),
  });
  const version =
    packageName === 'none'
      ? ''
      : await promptText({
          message: 'Package manager version requirement (optional)',
          initialValue: current.runtime.packageManager?.version ?? '',
          validate: (value) =>
            !value?.trim() ||
            v.safeParse(
              repoWorkflowProfileSchema.entries.runtime.entries.node,
              value.trim(),
            ).success
              ? undefined
              : 'Enter a semantic version requirement, such as >=10.',
        });
  const references = await promptText({
    message:
      'Environment variable names, comma-separated (never secret values)',
    initialValue: current.environmentRefs.join(', '),
    validate: (value) =>
      v.safeParse(
        repoWorkflowProfileSchema.entries.environmentRefs,
        (value ?? '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      ).success
        ? undefined
        : 'Enter unique environment variable names. Runtime control variables and secret values are not allowed.',
  });
  return v.parse(repoWorkflowProfileSchema, {
    id,
    name,
    setupCommands,
    validationCommands,
    setupTimeoutMs,
    validationTimeoutMs,
    runtime: {
      ...(node.trim() ? { node: node.trim() } : {}),
      ...(packageName !== 'none'
        ? {
            packageManager: {
              name: packageName,
              ...(version.trim() ? { version: version.trim() } : {}),
            },
          }
        : {}),
    },
    environmentRefs: references
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  });
}
export async function configureFactoryWorkflows(paths: RuntimePaths) {
  if (
    !(await promptConfirm({
      message: 'Set up optional repository setup and check workflows?',
      initialValue: false,
    }))
  )
    return;
  loadEnvForPaths(paths, { includeDevFallback: false });
  const repos = readRuntimeJsonSync(paths.repos, parseRepoRegistry).repos;
  if (!repos.length) {
    log.info(
      'Register a repository with neondeck repo add, then resume neondeck factory setup.',
    );
    return;
  }
  const repoId = await promptSelect({
    message: 'Repository workflow',
    options: repos.map((repo) => ({ value: repo.id, label: repo.id })),
  });
  let snapshot = readRepoWorkflows(repoId, paths);
  let draft = structuredClone(snapshot.workflows);
  if (
    await promptConfirm({
      message:
        'Ask Neon to suggest editable workflows from repository evidence?',
      initialValue: false,
    })
  ) {
    try {
      const result = await requestFactoryWorkflowProposal(
        repoId,
        snapshot.fingerprint,
        paths,
      );
      note(
        `${result.proposal.rationale}\nEvidence: ${result.proposal.evidencePaths.join(', ')}\nRevision: ${result.proposal.evidenceRevision}\n${summarizeFactoryWorkflows(result.proposal.workflows)}`,
        'Suggested workflows',
      );
      if (
        await promptConfirm({
          message: 'Use this suggestion as the editable draft?',
          initialValue: false,
        })
      )
        draft = result.proposal.workflows;
    } catch (error) {
      log.info(
        `${error instanceof Error ? error.message : 'Neon could not suggest workflows.'} Continue with manual setup; no configuration was saved.`,
      );
    }
  }
  do {
    const selected = draft
      ? await promptSelect({
          message: 'Profile to edit',
          options: [
            ...draft.profiles.map((profile) => ({
              value: profile.id,
              label: profile.name,
            })),
            ...(draft.profiles.length < 8
              ? [{ value: '__new__', label: 'Add profile' }]
              : []),
          ],
        })
      : '__new__';
    let suffix = (draft?.profiles.length ?? 0) + 1;
    while (
      draft?.profiles.some((profile) => profile.id === `profile-${suffix}`)
    )
      suffix++;
    const current = draft?.profiles.find(
      (profile) => profile.id === selected,
    ) ?? {
      id: `profile-${suffix}`,
      name: `Profile ${suffix}`,
      setupCommands: [],
      validationCommands: [],
      setupTimeoutMs: 300000,
      validationTimeoutMs: 300000,
      runtime: {},
      environmentRefs: [],
    };
    const profile = await editFactoryWorkflowProfile(
      current,
      (draft?.profiles ?? [])
        .filter((item) => item.id !== selected)
        .map((item) => item.id),
    );
    draft = {
      defaultProfileId:
        draft?.defaultProfileId === current.id
          ? profile.id
          : (draft?.defaultProfileId ?? null),
      profiles:
        selected === '__new__'
          ? [...(draft?.profiles ?? []), profile]
          : draft!.profiles.map((item) =>
              item.id === selected ? profile : item,
            ),
    };
  } while (
    await promptConfirm({
      message: 'Edit another workflow profile?',
      initialValue: false,
    })
  );
  const defaultId = await promptSelect({
    message: 'Default workflow profile',
    initialValue: draft.defaultProfileId ?? '__none__',
    options: [
      { value: '__none__', label: 'Choose explicitly per task' },
      ...draft.profiles.map((profile) => ({
        value: profile.id,
        label: profile.name,
      })),
    ],
  });
  draft = v.parse(repoFactoryWorkflowsSchema, {
    ...draft,
    defaultProfileId: defaultId === '__none__' ? null : defaultId,
  });
  note(
    summarizeFactoryWorkflows(draft),
    'Review repository workflow (references only)',
  );
  if (
    !(await promptConfirm({
      message: 'Save this repository workflow?',
      initialValue: false,
    }))
  ) {
    log.info('Repository workflow unchanged.');
    return;
  }
  snapshot = saveRepoWorkflows(
    repoId,
    { expectedFingerprint: snapshot.fingerprint, workflows: draft },
    paths,
  );
  log.success('Repository workflow saved.');
  if (
    await promptConfirm({
      message: 'Test setup and validation now?',
      initialValue: false,
    })
  ) {
    const profileId = await promptSelect({
      message: 'Saved profile to test',
      initialValue: draft.defaultProfileId ?? undefined,
      options: draft.profiles.map((profile) => ({
        value: profile.id,
        label: profile.name,
      })),
    });
    await runFactoryWorkflowTrial(
      repoId,
      profileId,
      snapshot.fingerprint,
      paths,
    );
  }
  log.info(
    `Set missing environment references in the private runtime environment at ${paths.env}. Runtime requirements do not install tools. Open /factory → Setup → Repository workflows to test setup and validation with progress, logs and cancellation.`,
  );
}

export function summarizeFactoryWorkflows(workflows: RepoFactoryWorkflows) {
  return [
    `Default: ${workflows.defaultProfileId ?? 'choose explicitly per task'}`,
    ...workflows.profiles.flatMap((profile) => [
      `\n${profile.name} (${profile.id})`,
      `Setup (${profile.setupTimeoutMs / 1000}s):`,
      ...(profile.setupCommands.length
        ? profile.setupCommands.map(
            (command, index) =>
              `  ${index + 1}. [${command.cwd}] ${command.command}`,
          )
        : ['  No setup commands.']),
      `Checks (${profile.validationTimeoutMs / 1000}s), plus mandatory repository checks:`,
      ...profile.validationCommands.map(
        (command, index) =>
          `  ${index + 1}. [${command.cwd}] ${command.command}`,
      ),
      `Runtime: Node ${profile.runtime.node ?? 'no requirement'}; ${profile.runtime.packageManager ? `${profile.runtime.packageManager.name} ${profile.runtime.packageManager.version ?? 'any installed version'}` : 'no package manager requirement'}`,
      `Environment references: ${profile.environmentRefs.join(', ') || 'none'}`,
    ]),
    'Saving does not run commands, approve tasks or change intake/authentication.',
  ].join('\n');
}
