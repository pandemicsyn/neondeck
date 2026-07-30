import { intro, log, note, outro, spinner } from '@clack/prompts';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { defaultOpenAiCodexModel } from '../model-defaults';
import { readDotEnvFile, type EnvLoadResult } from '../modules/runtime';
import {
  openAiCompatibleBaseUrlIssue,
  openAiCompatibleProviderIdIssue,
  type RuntimePaths,
} from '../runtime-home';
import type { EnvMap } from './types';
import {
  configActionsModule,
  githubModule,
  modelDiscoveryModule,
  runtimeHomeModule,
  runtimeStatusModule,
  sessionsModule,
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
type SetupModelProvider =
  'kilocode' | 'openai' | 'anthropic' | 'openai-codex' | 'openai-compatible';

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
  const freshInstall = !existsSync(paths.neondeckDatabase);
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
  await configureDashboard(paths);
  await configureExecution(paths);
  await configureSkillRoots(paths);
  await finalizeFreshInstallSession(paths, freshInstall);

  const status = await readRuntimeStatus(paths);
  const failedChecks = status.checks.filter((check) => !check.ok);
  const packagedInstall = hasPackagedServerEntry();
  const statusLines = [
    `home      ${paths.home}`,
    `status    ${status.status}`,
    `model     ${status.models.displayAssistant}`,
    `github    ${status.providers.credentials.github ? 'configured' : 'missing'}`,
    `kilo      ${status.providers.credentials.kilo ? 'configured' : 'missing'}`,
    `openai    ${status.providers.credentials.openai ? 'configured' : 'missing'}`,
    `chatgpt   ${status.providers.credentials.openaiCodex ? 'configured' : 'missing'}`,
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
    ...formatOnboardingNextSteps(packagedInstall, status.autopilot?.repoId),
  );
  note(
    statusLines.join('\n'),
    status.status === 'ready'
      ? 'neondeck is ready'
      : 'neondeck runtime prepared; config remains',
  );
  outro(
    status.status === 'ready'
      ? packagedInstall
        ? 'Setup complete. Run `neondeck open` to launch the deck.'
        : 'Setup complete. Run `npm run dev` to launch the deck.'
      : 'Finish the remaining config, then start the deck.',
  );
}

export function hasPackagedServerEntry(env: NodeJS.ProcessEnv = process.env) {
  const entry =
    env.NEONDECK_SERVER_ENTRY ??
    new URL('../../dist/server.mjs', import.meta.url);
  return existsSync(entry);
}

export function formatOnboardingNextSteps(
  packagedInstall: boolean,
  autopilotRepoId?: string,
) {
  return [
    '',
    'Next:',
    ...(packagedInstall
      ? ['  neondeck service install', '  neondeck open']
      : ['  npm run dev', '  open http://127.0.0.1:5173/']),
    ...(autopilotRepoId
      ? [
          '',
          'Optional diagnostics:',
          `  neondeck doctor --repo ${autopilotRepoId}`,
        ]
      : []),
  ];
}

export async function finalizeFreshInstallSession(
  paths: RuntimePaths,
  freshInstall: boolean,
) {
  if (!freshInstall) return;
  const { rebaselineFreshInstallChatSession } = await sessionsModule();
  await rebaselineFreshInstallChatSession(paths);
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
        label: 'OpenAI API key',
        hint: 'Usage-based OpenAI API billing via OPENAI_API_KEY.',
      },
      {
        value: 'openai-codex',
        label: 'ChatGPT subscription',
        hint: 'Sign in with ChatGPT OAuth; no API key required.',
      },
      {
        value: 'anthropic',
        label: 'Anthropic',
        hint: 'Built-in Flue provider using ANTHROPIC_API_KEY.',
      },
      {
        value: 'openai-compatible',
        label: 'OpenAI-compatible endpoint',
        hint: 'OpenRouter, a local server, or another compatible API.',
      },
    ],
  });

  let modelProvider: string = provider;
  let configInput: Parameters<typeof updateProviderConfig>[0];
  if (provider === 'openai-compatible') {
    const custom = await configureOpenAiCompatibleProvider(env, paths);
    modelProvider = custom.id;
    configInput = custom.configInput;
  } else {
    await configureProviderSecret(provider, env, paths);
    configInput = providerConfigInput(provider, env);
  }
  loadEnvForPaths(paths, { includeDevFallback: false, overwrite: true });

  const model = await chooseModel(modelProvider, env);
  const thinkingLevel = await promptThinkingLevel();
  const utilityModel = await chooseUtilityModel(modelProvider, env, model);

  await updateProviderConfig(configInput, paths);
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
  provider: string,
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
  if (provider === 'openai-codex') {
    const method = await promptSelect<'browser' | 'device-code'>({
      message: 'ChatGPT sign-in method',
      initialValue: 'browser',
      options: [
        {
          value: 'browser',
          label: 'Browser',
          hint: 'Recommended on this computer.',
        },
        {
          value: 'device-code',
          label: 'Device code',
          hint: 'Use another browser or a headless machine.',
        },
      ],
    });
    const { loginOpenAiCodexSubscription } = await modelDiscoveryModule();
    const spin = spinner();
    spin.start('Waiting for ChatGPT authorization');
    try {
      await loginOpenAiCodexSubscription(
        method,
        {
          onAuth(info) {
            spin.stop('Continue sign-in in your browser');
            note(info.url, info.instructions ?? 'ChatGPT sign-in');
            openExternalUrl(info.url);
            spin.start('Waiting for ChatGPT authorization');
          },
          onDeviceCode(info) {
            spin.stop('Enter this code to authorize Neondeck');
            note(
              `${info.userCode}\n\n${info.verificationUri}`,
              'ChatGPT device code',
            );
            openExternalUrl(info.verificationUri);
            spin.start('Waiting for ChatGPT authorization');
          },
          onPrompt: (message, options) =>
            promptText({
              message,
              placeholder:
                options.placeholder ?? 'Paste the authorization code',
              signal: options.signal,
            }),
          onProgress(message) {
            spin.message(message);
          },
        },
        paths,
      );
      spin.stop('Signed in with your ChatGPT subscription');
    } catch (error) {
      spin.stop('ChatGPT sign-in failed');
      throw error;
    }
    return;
  }

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
  } else if (provider !== 'openai-compatible') {
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

export async function chooseModel(provider: string, env: EnvMap) {
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
  provider: string,
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

export function providerConfigInput(
  provider: Exclude<SetupModelProvider, 'openai-compatible'>,
  env: EnvMap,
) {
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

  if (provider === 'openai-codex') {
    return {
      provider,
      enabled: true,
    };
  }

  return {
    provider,
    enabled: true,
    apiKeyEnv: provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY',
  };
}

export function defaultProviderModel(provider: string) {
  if (provider === 'openai') return 'openai/gpt-5.5';
  if (provider === 'openai-codex') return defaultOpenAiCodexModel;
  if (provider === 'anthropic') return 'anthropic/claude-sonnet-4-6';
  if (provider === 'openrouter') return 'openrouter/openai/gpt-5.5';
  if (provider !== 'kilocode') return `${provider}/gpt-5.5`;
  return defaultModel;
}

export function providerFromModel(model: string): SetupModelProvider {
  const provider = model.includes('/') ? model.split('/')[0] : 'kilocode';
  if (
    provider === 'openai' ||
    provider === 'anthropic' ||
    provider === 'openai-codex'
  )
    return provider;
  return 'kilocode';
}

async function configureOpenAiCompatibleProvider(
  env: EnvMap,
  paths: RuntimePaths,
) {
  const id = (
    await promptText({
      message: 'Provider id',
      initialValue: 'openrouter',
      placeholder: 'openrouter',
      validate: openAiCompatibleProviderIdIssue,
    })
  ).trim();
  const baseUrl = (
    await promptText({
      message: 'OpenAI-compatible base URL',
      initialValue:
        id === 'openrouter'
          ? 'https://openrouter.ai/api/v1'
          : 'https://example.com/v1',
      validate: openAiCompatibleBaseUrlIssue,
    })
  ).replace(/\/+$/, '');
  const api = await promptSelect<'openai-completions' | 'openai-responses'>({
    message: 'Compatible API protocol',
    initialValue: 'openai-completions',
    options: [
      {
        value: 'openai-completions',
        label: 'Chat Completions',
        hint: 'OpenRouter and most compatible endpoints.',
      },
      {
        value: 'openai-responses',
        label: 'Responses',
        hint: 'Endpoints implementing OpenAI Responses.',
      },
    ],
  });
  const suggestedEnv = `${id.replaceAll('-', '_').toUpperCase()}_API_KEY`;
  const requiresApiKey = await promptConfirm({
    message: 'Does this endpoint require an API key?',
    initialValue: true,
  });
  let apiKeyEnv: string | undefined;
  if (requiresApiKey) {
    apiKeyEnv = (
      await promptText({
        message: 'API key environment variable',
        initialValue: suggestedEnv,
        placeholder: suggestedEnv,
        validate(value) {
          return /^[A-Z_][A-Z0-9_]*$/.test(value ?? '')
            ? undefined
            : 'Use a valid uppercase environment variable name.';
        },
      })
    ).trim();
    const value = await promptPassword({
      message: env.get(apiKeyEnv)
        ? `${id} API key (blank keeps existing)`
        : `${id} API key`,
      required: !env.get(apiKeyEnv),
    });
    if (value) env.set(apiKeyEnv, value);
  }
  await writeDotEnvFile(paths.env, env);
  log.success(`Wrote ${paths.env}`);

  return {
    id,
    configInput: {
      provider: 'openai-compatible' as const,
      id,
      enabled: true,
      baseUrl,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      api,
    },
  };
}

function openExternalUrl(url: string) {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {});
  child.unref();
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
        hint: 'Reviews, GitHub, watches, chat, briefing, and runtime tools.',
      },
      {
        value: 'classic',
        label: 'Classic',
        hint: 'Reviews and GitHub on the left; chat on the right.',
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
    message: 'Preapprove safe-ish local commands?',
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

  const selectedExternalRoots = Array.from(
    new Set([...current, ...selectedDetectedRoots]),
  );
  note(
    formatRuntimeSkillRootsNote(paths.skills, selectedExternalRoots),
    'Runtime skill locations',
  );

  const shouldAddManual = await promptConfirm({
    message: 'Add another optional external runtime skill root?',
    initialValue: false,
  });
  const manualRoot = shouldAddManual
    ? await promptText({
        message: 'Skill root path',
        placeholder: '~/.agents/skills',
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

export function formatRuntimeSkillRootsNote(
  localRoot: string,
  externalRoots: string[],
) {
  return [
    `Local root (always scanned): ${localRoot}`,
    externalRoots.length > 0
      ? `External roots:\n${externalRoots.map((root) => `  ${root}`).join('\n')}`
      : 'External roots: none',
    'Example external root: ~/.agents/skills (auto-detected when present)',
    'Expected layout: <root>/<skill-name>/SKILL.md',
    'Bundled Neondeck skills load automatically.',
  ].join('\n');
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
