import { intro, log, note, outro, spinner } from '@clack/prompts';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readDotEnvFile, type EnvLoadResult } from '../modules/runtime';
import type { RuntimePaths } from '../runtime-home';
import type { EnvMap } from './types';
import {
  configActionsModule,
  githubModule,
  modelDiscoveryModule,
  runtimeHomeModule,
  runtimeStatusModule,
} from './modules';
import { loadEnvForPaths } from './options';
import {
  expandHome,
  findGitRepos,
  promptConfirm,
  promptMultiselect,
  promptPassword,
  promptSelect,
  promptText,
  requiredText,
  writeDotEnvFile,
} from './prompts';
import { readConfigData } from './output';
import { preapprovalGroups, type PreapprovalGroupId } from './preapprovals';

const defaultModel = 'kilocode/kilo-auto/balanced';
type SetupModelProvider = 'kilocode' | 'openai' | 'anthropic';

export async function runInit(options: { home?: string }) {
  intro('neondeck init');
  const { ensureRuntimeHome, runtimePaths, validateRuntimeFiles } =
    await runtimeHomeModule();
  const { readRuntimeStatus } = await runtimeStatusModule();

  const suggestedHome = options.home
    ? expandHome(options.home)
    : runtimePaths().home;
  const home = await promptText({
    message: 'Runtime home',
    placeholder: suggestedHome,
    initialValue: suggestedHome,
    validate(value) {
      return value?.trim().length === 0
        ? 'Enter a runtime home path.'
        : undefined;
    },
  });
  const paths = runtimePaths(expandHome(home));
  const spin = spinner();
  spin.start('Preparing runtime home');
  await ensureRuntimeHome(paths);
  await validateRuntimeFiles(paths);
  const envLoad = loadEnvForPaths(paths);
  spin.stop('Runtime home is ready');

  await configureSecrets(paths, envLoad);
  loadEnvForPaths(paths, { includeDevFallback: false, overwrite: true });
  await configureSoul(paths);
  await configureProviderAndModels(paths);
  await configureRepos(paths);
  await configureAutopilotOnboarding();
  await configureDashboard(paths);
  await configureExecution(paths);
  await configureSkillRoots(paths);

  const status = await readRuntimeStatus(paths);
  const failedChecks = status.checks.filter((check) => !check.ok);
  const statusLines = [
    `home      ${paths.home}`,
    `status    ${status.status}`,
    `model     ${status.models.displayAssistant}`,
    `github    ${status.providers.credentials.github ? 'configured' : 'missing'}`,
    `kilo      ${status.providers.credentials.kilo ? 'configured' : 'missing'}`,
    `openai    ${status.providers.credentials.openai ? 'configured' : 'missing'}`,
    `anthropic ${status.providers.credentials.anthropic ? 'configured' : 'missing'}`,
    `repos     ${status.counts.repos}`,
    `autopilot ${status.autopilot ? `${status.autopilot.status} (${status.autopilot.repoId})` : 'needs a repo'}`,
  ];
  if (failedChecks.length > 0) {
    statusLines.push(
      '',
      'Remaining:',
      ...failedChecks.map((check) => `  ${check.label}: ${check.message}`),
    );
  }
  statusLines.push(
    '',
    'Next:',
    '  npm run dev',
    '  open http://127.0.0.1:5173/',
    ...(status.autopilot
      ? [
          `  neondeck doctor --repo ${status.autopilot.repoId} --pr <number> --mode <mode>`,
        ]
      : []),
  );
  note(
    statusLines.join('\n'),
    status.status === 'ready'
      ? 'neondeck is ready'
      : 'neondeck runtime prepared; config remains',
  );
  outro(
    status.status === 'ready'
      ? 'The deck is live.'
      : 'Finish the remaining config, then start the deck.',
  );
}

async function configureAutopilotOnboarding() {
  const configure = await promptConfirm({
    message: 'Configure Autopilot for a PR now?',
    initialValue: false,
  });
  if (!configure) return;
  const mode = await promptSelect({
    message: 'Autopilot mode',
    initialValue: 'prepare-only',
    options: [
      {
        value: 'notify-only',
        label: 'Notify only',
        hint: 'Report meaningful PR changes without preparing fixes.',
      },
      {
        value: 'prepare-only',
        label: 'Prepare only',
        hint: 'Prepare a bounded fix for your review; never push.',
      },
      {
        value: 'autofix-with-approval',
        label: 'Fix with approval',
        hint: 'Prepare fixes and require explicit approval before push.',
      },
      {
        value: 'autofix-push-when-safe',
        label: 'Safe push',
        hint: 'Push only policy-safe, verified fixes.',
      },
    ],
  });
  note(
    `Autopilot ${mode} selected. Configure a PR with: neondeck autopilot watch <repo>#<pr> --mode ${mode} --confirm`,
    'Autopilot',
  );
}

export async function configureSecrets(
  paths: RuntimePaths,
  envLoad: EnvLoadResult,
) {
  const { fetchGitHubLogin } = await githubModule();
  const env = await readDotEnvFile(paths.env);
  const shouldEdit = await promptConfirm({
    message:
      env.size > 0
        ? 'Review runtime-home .env secrets?'
        : 'Create runtime-home .env secrets?',
    initialValue: true,
  });
  if (!shouldEdit) return;

  const devFallback = envLoad.files.find((file) => file.id === 'dev');
  if (env.size === 0 && devFallback?.loaded) {
    log.info(
      `Using ${devFallback.path} as a dev fallback until runtime .env is written.`,
    );
  }

  const githubToken = await promptPassword({
    message: env.get('GITHUB_TOKEN')
      ? 'GitHub token (blank keeps existing)'
      : 'GitHub token',
    required: !env.get('GITHUB_TOKEN'),
  });
  if (githubToken) env.set('GITHUB_TOKEN', githubToken);

  const githubLogin = await promptText({
    message: 'GitHub login',
    placeholder: 'optional; auto-detected when blank',
    initialValue: env.get('GITHUB_LOGIN') ?? '',
  });
  if (githubLogin.trim()) env.set('GITHUB_LOGIN', githubLogin.trim());
  else env.delete('GITHUB_LOGIN');

  await writeDotEnvFile(paths.env, env);
  log.success(`Wrote ${paths.env}`);

  const token = env.get('GITHUB_TOKEN');
  if (token && !env.get('GITHUB_LOGIN')) {
    const spin = spinner();
    spin.start('Checking GitHub identity');
    try {
      const login = await fetchGitHubLogin(token);
      env.set('GITHUB_LOGIN', login);
      await writeDotEnvFile(paths.env, env);
      spin.stop(`GitHub login detected: ${login}`);
    } catch (error) {
      spin.stop('GitHub login could not be detected');
      log.warn(error instanceof Error ? error.message : String(error));
    }
  }
}

export async function configureSoul(paths: RuntimePaths) {
  const shouldEdit = await promptConfirm({
    message: 'Tune Neon’s SOUL.md?',
    initialValue: true,
  });
  if (!shouldEdit) return;

  const name = await promptText({
    message: 'Agent name',
    placeholder: 'Neon',
    initialValue: 'Neon',
    validate: requiredText,
  });
  const emoji = await promptText({
    message: 'Agent emoji',
    placeholder: '🟢',
    initialValue: '🟢',
    validate: requiredText,
  });
  const vibe = await promptText({
    message: 'Vibe',
    placeholder: 'Concise, observant, practical; favors concrete next actions.',
    initialValue:
      'A calm, technical companion for a developer side display. Concise, observant, and practical.',
    validate: requiredText,
  });

  await writeFile(
    paths.soul,
    [
      '# Soul',
      '',
      `name: ${name}`,
      `emoji: ${emoji}`,
      '',
      '## Vibe',
      '',
      vibe,
      '',
    ].join('\n'),
    'utf8',
  );
  log.success(`Updated ${paths.soul}`);
}

export async function configureProviderAndModels(paths: RuntimePaths) {
  const { updateAgentModels, updateProviderConfig } =
    await configActionsModule();
  const env = await readDotEnvFile(paths.env);
  const provider = await promptSelect<SetupModelProvider>({
    message: 'Model provider',
    initialValue: providerFromModel(
      env.get('FLUE_AGENT_MODEL') ?? defaultModel,
    ),
    options: [
      {
        value: 'kilocode',
        label: 'KiloCode',
        hint: 'Custom Flue provider and searchable model catalog.',
      },
      {
        value: 'openai',
        label: 'OpenAI',
        hint: 'Built-in Flue provider using OPENAI_API_KEY.',
      },
      {
        value: 'anthropic',
        label: 'Anthropic',
        hint: 'Built-in Flue provider using ANTHROPIC_API_KEY.',
      },
    ],
  });

  await configureProviderSecret(provider, env, paths);
  loadEnvForPaths(paths, { includeDevFallback: false, overwrite: true });

  const model = await chooseModel(provider, env);
  const thinkingLevel = await promptThinkingLevel();
  const utilityModel = await chooseUtilityModel(provider, env, model);

  await updateProviderConfig(providerConfigInput(provider, env), paths);
  await updateAgentModels(
    {
      displayAssistant: model,
      displayAssistantThinkingLevel: thinkingLevel,
      ...(utilityModel
        ? { utility: utilityModel, utilityThinkingLevel: 'low' }
        : {}),
      subagents: {
        default: model,
        defaultThinkingLevel: thinkingLevel,
        repoResearcher: model,
        ciInvestigator: model,
        releaseReviewer: model,
      },
    },
    paths,
  );
}

export async function chooseUtilityModel(
  provider: SetupModelProvider,
  env: EnvMap,
  displayModel: string,
) {
  const mode = await promptSelect<'default' | 'manual' | 'skip'>({
    message: 'Utility model',
    initialValue: 'default',
    options: [
      {
        value: 'default',
        label: 'Use display model',
        hint: 'Skip for now; Neondeck will recommend a cheaper model later.',
      },
      {
        value: 'manual',
        label: 'Choose low-cost model',
        hint: 'For short titles, labels, notifications, and classifications.',
      },
      { value: 'skip', label: 'Skip' },
    ],
  });

  if (mode !== 'manual') return undefined;
  if (provider === 'kilocode') return chooseModel(provider, env);
  return promptModelText(provider, displayModel, 'Utility model');
}

export async function configureProviderSecret(
  provider: SetupModelProvider,
  env: EnvMap,
  paths: RuntimePaths,
) {
  if (provider === 'kilocode') {
    const kiloKey = await promptPassword({
      message: env.get('KILOCODE_API_KEY')
        ? 'Kilo API key (blank keeps existing)'
        : 'Kilo API key',
      required: !env.get('KILOCODE_API_KEY'),
    });
    if (kiloKey) env.set('KILOCODE_API_KEY', kiloKey);

    const orgId = await promptText({
      message: 'Kilo organization id',
      placeholder: env.get('KILOCODE_ORGANIZATION_ID') ?? 'optional',
      initialValue: env.get('KILOCODE_ORGANIZATION_ID') ?? '',
    });
    if (orgId.trim()) env.set('KILOCODE_ORGANIZATION_ID', orgId.trim());
    else env.delete('KILOCODE_ORGANIZATION_ID');
  } else {
    const key = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    const label = provider === 'openai' ? 'OpenAI' : 'Anthropic';
    const value = await promptPassword({
      message: env.get(key)
        ? `${label} API key (blank keeps existing)`
        : `${label} API key`,
      required: !env.get(key),
    });
    if (value) env.set(key, value);
  }

  await writeDotEnvFile(paths.env, env);
  log.success(`Wrote ${paths.env}`);
}

export async function chooseModel(provider: SetupModelProvider, env: EnvMap) {
  if (provider !== 'kilocode') {
    return promptModelText(provider, defaultProviderModel(provider));
  }

  const { discoverModels } = await modelDiscoveryModule();
  const spin = spinner();
  spin.start('Discovering KiloCode models');
  const result = await discoverModels({
    provider,
    apiKey: env.get('KILOCODE_API_KEY'),
    organizationId: env.get('KILOCODE_ORGANIZATION_ID'),
  });
  spin.stop(
    result.ok
      ? `Discovered ${result.models.length} KiloCode models`
      : 'KiloCode discovery unavailable',
  );
  if (!result.ok && result.error) log.warn(result.error);

  const mode = await promptSelect<'search' | 'default' | 'manual'>({
    message: 'KiloCode model',
    initialValue: 'default',
    options: [
      {
        value: 'default',
        label: defaultModel,
        hint: 'Use the recommended default.',
      },
      {
        value: 'search',
        label: 'Search models',
        hint: 'Filter discovered KiloCode models.',
      },
      { value: 'manual', label: 'Manual entry' },
    ],
  });

  if (mode === 'default') return defaultModel;
  if (mode === 'manual') return promptModelText(provider, defaultModel);

  const query = await promptText({
    message: 'Search KiloCode models',
    placeholder: 'sonnet, gpt, kimi, free',
  });
  const matches = result.models
    .filter((model) => {
      const text = `${model.id} ${model.name}`.toLowerCase();
      return text.includes(query.trim().toLowerCase());
    })
    .slice(0, 12);

  if (matches.length === 0) {
    log.warn('No discovered models matched that search.');
    return promptModelText(provider, defaultModel);
  }

  return promptSelect<string>({
    message: 'Select model',
    options: matches.map((model) => ({
      value: model.id,
      label: model.id,
      hint: [
        model.name,
        model.contextLength ? `${model.contextLength} ctx` : null,
        model.reasoning ? 'reasoning' : null,
        model.isFree ? 'free' : null,
      ]
        .filter(Boolean)
        .join(' · '),
    })),
  });
}

export async function promptModelText(
  provider: SetupModelProvider,
  initialValue: string,
  message = 'Display assistant model',
) {
  return promptText({
    message,
    placeholder: initialValue,
    initialValue,
    validate(value) {
      if (!value?.includes('/')) {
        return `Use a provider-qualified model, for example ${initialValue}.`;
      }

      if (value.split('/')[0] !== provider) {
        return `Use a ${provider}/... model for the selected provider.`;
      }

      return undefined;
    },
  });
}

export async function promptThinkingLevel() {
  return promptSelect<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>({
    message: 'Thinking level',
    initialValue: 'medium',
    options: [
      { value: 'medium', label: 'medium', hint: 'Balanced default.' },
      { value: 'high', label: 'high', hint: 'More careful reasoning.' },
      { value: 'low', label: 'low', hint: 'Lower cost or latency.' },
      {
        value: 'minimal',
        label: 'minimal',
        hint: 'Smallest reasoning effort.',
      },
      { value: 'off', label: 'off', hint: 'Do not request extra reasoning.' },
      { value: 'xhigh', label: 'xhigh', hint: 'Highest exposed effort tier.' },
    ],
  });
}

export function providerConfigInput(provider: SetupModelProvider, env: EnvMap) {
  if (provider === 'kilocode') {
    return {
      provider,
      enabled: true,
      apiKeyEnv: 'KILOCODE_API_KEY',
      organizationIdEnv: env.get('KILOCODE_ORGANIZATION_ID')
        ? 'KILOCODE_ORGANIZATION_ID'
        : null,
    };
  }

  return {
    provider,
    enabled: true,
    apiKeyEnv: provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY',
  };
}

export function defaultProviderModel(provider: SetupModelProvider) {
  if (provider === 'openai') return 'openai/gpt-5.5';
  if (provider === 'anthropic') return 'anthropic/claude-sonnet-4-6';
  return defaultModel;
}

export function providerFromModel(model: string): SetupModelProvider {
  const provider = model.includes('/') ? model.split('/')[0] : 'kilocode';
  if (provider === 'openai' || provider === 'anthropic') return provider;
  return 'kilocode';
}

export async function configureRepos(paths: RuntimePaths) {
  const mode = await promptSelect<'manual' | 'scan' | 'skip'>({
    message: 'Add repositories?',
    initialValue: 'manual',
    options: [
      {
        value: 'manual',
        label: 'Add paths',
        hint: 'Paste one local checkout at a time.',
      },
      {
        value: 'scan',
        label: 'Scan folder',
        hint: 'Find one-level-deep git checkouts.',
      },
      { value: 'skip', label: 'Skip for now' },
    ],
  });

  if (mode === 'skip') return;
  if (mode === 'scan') {
    const parent = await promptText({
      message: 'Folder to scan',
      placeholder: join(homedir(), 'Developer'),
      initialValue: join(homedir(), 'Developer'),
      validate: requiredText,
    });
    const candidates = await findGitRepos(parent);
    if (candidates.length === 0) {
      log.warn('No one-level-deep git checkouts found.');
      return;
    }

    const selected = await promptMultiselect<string>({
      message: 'Select repositories',
      options: candidates.map((candidate) => ({
        value: candidate,
        label: candidate,
      })),
    });
    for (const repoPath of selected) {
      await addRepoWithFeedback(repoPath, paths);
    }
    return;
  }

  let keepGoing = true;
  while (keepGoing) {
    const repoPath = await promptText({
      message: 'Local repo path',
      placeholder: '/Users/alice/dev/project',
      validate: requiredText,
    });
    await addRepoWithFeedback(repoPath, paths);
    keepGoing = await promptConfirm({
      message: 'Add another repo?',
      initialValue: false,
    });
  }
}

export async function configureDashboard(paths: RuntimePaths) {
  const { applyDashboardPreset } = await configActionsModule();
  const preset = await promptSelect<'cockpit' | 'classic'>({
    message: 'Dashboard preset',
    initialValue: 'cockpit',
    options: [
      {
        value: 'cockpit',
        label: 'Cockpit',
        hint: 'Work queue, chat, watches, Autopilot, briefing, runtime.',
      },
      {
        value: 'classic',
        label: 'Classic',
        hint: 'GitHub, Autopilot, and Neon.',
      },
    ],
  });
  const statuslinePosition = await promptSelect<'top' | 'bottom'>({
    message: 'Statusline position',
    initialValue: 'top',
    options: [
      { value: 'top', label: 'Top' },
      { value: 'bottom', label: 'Bottom' },
    ],
  });

  await applyDashboardPreset({ preset, statuslinePosition }, paths);
}

export async function configureExecution(paths: RuntimePaths) {
  const { updateExecutionPolicy } = await configActionsModule();
  const preapprove = await promptMultiselect<PreapprovalGroupId>({
    message: 'Preapprove safe local commands?',
    options: preapprovalGroups.map((group) => ({
      value: group.id,
      label: group.label,
      hint: group.hint,
    })),
    initialValues: preapprovalGroups.map((group) => group.id),
  });
  if (preapprove.length === 0) return;

  const selectedGroups = preapprovalGroups.filter((group) =>
    preapprove.includes(group.id),
  );
  const preapprovedCommands = selectedGroups.flatMap((group) => group.commands);

  await updateExecutionPolicy(
    {
      defaultBackend: 'local',
      enabledBackends: ['local'],
      approvalMode: 'manual',
      unattended: 'deny',
      preapprovedCommands: preapprovedCommands.map((command) => ({
        ...command,
        backends: ['local'],
      })),
    },
    paths,
  );
}

export async function configureSkillRoots(paths: RuntimePaths) {
  const { readConfig, updateSkillRoots } = await configActionsModule();
  const config = await readConfig({ target: 'config' }, paths);
  const current = readConfigData(config).skillRoots ?? [];
  const detectedRoots = detectExternalSkillRoots();
  const selectableDetectedRoots = detectedRoots.filter(
    (root) => !current.includes(root),
  );
  const selectedDetectedRoots =
    selectableDetectedRoots.length > 0
      ? await promptMultiselect<string>({
          message: 'Add detected external runtime skill roots?',
          options: selectableDetectedRoots.map((root) => ({
            value: root,
            label: root,
          })),
          initialValues: selectableDetectedRoots,
        })
      : [];

  const shouldAddManual = await promptConfirm({
    message: 'Add another external runtime skill root?',
    initialValue: false,
  });
  const manualRoot = shouldAddManual
    ? await promptText({
        message: 'Skill root path',
        placeholder: '/Users/alice/.agents/skills',
        validate: requiredText,
      })
    : undefined;

  const next = Array.from(
    new Set([
      ...current,
      ...selectedDetectedRoots,
      ...(manualRoot ? [expandHome(manualRoot)] : []),
    ]),
  );
  if (next.length === current.length) return;

  const result = await updateSkillRoots({ skillRoots: next }, paths);
  if (result.ok) log.success(result.message);
  else log.warn(result.message);
}

export function detectExternalSkillRoots() {
  return [join(homedir(), '.agents', 'skills')].filter((root) =>
    existsSync(root),
  );
}

export async function addRepoWithFeedback(
  repoPath: string,
  paths: RuntimePaths,
) {
  const { addRepo } = await configActionsModule();
  const result = await addRepo({ path: repoPath }, paths);
  if (result.ok) log.success(result.message);
  else {
    log.warn(result.message);
    if (result.requires?.length) {
      log.info(`Requires: ${result.requires.join(', ')}`);
    }
  }
}
