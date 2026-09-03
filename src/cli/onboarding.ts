import { intro, log, note, outro, spinner } from '@clack/prompts';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { runUnattendedGit } from '../lib/git';
import { defaultGatewayModel } from '../lib/gateway-model-policy';
import { defaultOpenAiCodexModel } from '../model-defaults';
import {
  searchDiscoveredModels,
  type ModelDiscoveryResult,
} from '../modules/model-catalog';
import { readDotEnvFile, type EnvLoadResult } from '../modules/runtime';
import {
  openAiCompatibleBaseUrlIssue,
  openAiCompatibleProviderIdIssue,
  type RuntimePaths,
  type ThinkingLevel,
} from '../runtime-home';
import type { EnvMap } from './types';
import {
  configActionsModule,
  githubModule,
  modelDiscoveryModule,
  reposModule,
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
import { formatProviderCredentialLines, readConfigData } from './output';
import { preapprovalGroups, type PreapprovalGroupId } from './preapprovals';

const defaultModel = 'kilocode/kilo-auto/balanced';
export const exploreModelRecommendation =
  'Recommended: OpenAI Luna or OpenAI Terra at medium reasoning.';
type SetupModelProvider =
  | 'kilocode'
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'opencode'
  | 'google-vertex'
  | 'openai-codex'
  | 'openai-compatible';

type ModelDiscoveryCache = Map<string, Promise<ModelDiscoveryResult>>;

export type SetupGitIdentityResult = {
  status: 'ready' | 'configured' | 'skipped' | 'unavailable';
  name: string | null;
  email: string | null;
};

type GitIdentitySetupDependencies = {
  persistedEnv?: NodeJS.ProcessEnv;
  runGit?: (args: string[]) => Promise<string>;
  confirm?: typeof promptConfirm;
  text?: typeof promptText;
  warn?: (message: string) => void;
  success?: (message: string) => void;
};

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
  await configureGitIdentity({
    persistedEnv: Object.fromEntries(await readDotEnvFile(paths.env)),
  });
  await configureSoul(paths);
  await configureProviderAndModels(paths);
  await configureRepos(paths);
  await configureDashboard(paths);
  await configureExecution(paths);
  await configureSkillRoots(paths);
  await finalizeFreshInstallSession(paths);

  const status = await readRuntimeStatus(paths);
  const failedChecks = status.checks.filter((check) => !check.ok);
  const packagedInstall = hasPackagedServerEntry();
  const statusLines = [
    `home      ${paths.home}`,
    `status    ${status.status}`,
    `model     ${status.models.displayAssistant}`,
    ...formatProviderCredentialLines(status.providers.credentials),
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
        ? 'Setup complete. Run `neondeck open` to start the server and open the UI; press Ctrl-C to stop.'
        : 'Setup complete. Run `npm run dev` to launch the deck.'
      : 'Finish the remaining config, then start the deck.',
  );
}

export async function configureGitIdentity(
  dependencies: GitIdentitySetupDependencies = {},
): Promise<SetupGitIdentityResult> {
  const persistedEnv = dependencies.persistedEnv ?? {};
  const runGit =
    dependencies.runGit ?? ((args) => runUnattendedGit(process.cwd(), args));
  const confirm = dependencies.confirm ?? promptConfirm;
  const text = dependencies.text ?? promptText;
  const warn = dependencies.warn ?? ((message: string) => log.warn(message));
  const success =
    dependencies.success ?? ((message: string) => log.success(message));

  try {
    await runGit(['--version']);
  } catch (error) {
    warn(
      `Git identity could not be checked: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { status: 'unavailable', name: null, email: null };
  }

  const [configuredName, configuredEmail] = await Promise.all([
    readGlobalGitValue(runGit, 'user.name'),
    readGlobalGitValue(runGit, 'user.email'),
  ]);
  const authorName = persistedEnv.GIT_AUTHOR_NAME?.trim() || configuredName;
  const authorEmail = persistedEnv.GIT_AUTHOR_EMAIL?.trim() || configuredEmail;
  const committerName =
    persistedEnv.GIT_COMMITTER_NAME?.trim() || configuredName;
  const committerEmail =
    persistedEnv.GIT_COMMITTER_EMAIL?.trim() || configuredEmail;

  if (authorName && authorEmail && committerName && committerEmail) {
    success(`Git commit identity is ready: ${authorName} <${authorEmail}>`);
    return { status: 'ready', name: authorName, email: authorEmail };
  }

  const missing = [
    !authorName && 'author name',
    !authorEmail && 'author email',
    !committerName && 'committer name',
    !committerEmail && 'committer email',
  ].filter(Boolean);
  warn(
    `Git commit identity is incomplete (${missing.join(', ')} missing). Autopilot commits may otherwise use an OS-generated identity.`,
  );
  const shouldConfigure = await confirm({
    message: 'Configure a global Git commit identity now?',
    initialValue: true,
  });
  if (!shouldConfigure) {
    return {
      status: 'skipped',
      name: authorName || null,
      email: authorEmail || null,
    };
  }

  const name = (
    await text({
      message: 'Git author name',
      placeholder: 'Your Name',
      initialValue: configuredName || authorName,
      validate: requiredText,
    })
  ).trim();
  const email = (
    await text({
      message: 'Git author email',
      placeholder: 'you@example.com',
      initialValue: configuredEmail || authorEmail,
      validate: requiredText,
    })
  ).trim();

  try {
    await runGit(['config', '--global', '--replace-all', 'user.name', name]);
    await runGit(['config', '--global', '--replace-all', 'user.email', email]);
    await runGit([
      'config',
      '--global',
      '--replace-all',
      'user.useConfigOnly',
      'true',
    ]);
  } catch (error) {
    warn(
      `Global Git identity could not be configured: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { status: 'unavailable', name, email };
  }

  success(`Configured global Git identity: ${name} <${email}>`);
  return { status: 'configured', name, email };
}

async function readGlobalGitValue(
  runGit: (args: string[]) => Promise<string>,
  key: 'user.name' | 'user.email',
) {
  return runGit(['config', '--global', '--get', key])
    .then((value) => value.trim())
    .catch(() => '');
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
      ? [
          '  neondeck open  # start the server and open the UI',
          '',
          'Optional login service:',
          '  neondeck service install',
        ]
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

export async function finalizeFreshInstallSession(paths: RuntimePaths) {
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
        value: 'openrouter',
        label: 'OpenRouter',
        hint: 'Search the live OpenRouter catalog using OPENROUTER_API_KEY.',
      },
      {
        value: 'opencode',
        label: 'OpenCode Zen',
        hint: 'Search Zen models with native per-model protocol support.',
      },
      {
        value: 'google-vertex',
        label: 'Google Vertex AI',
        hint: 'Gemini through Vertex using an API key or Google Cloud ADC.',
      },
      {
        value: 'openai-compatible',
        label: 'OpenAI-compatible endpoint',
        hint: 'A local server or another custom compatible API.',
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

  const discoveryCache: ModelDiscoveryCache = new Map();
  const model = await chooseModel(modelProvider, env, discoveryCache);
  const thinkingLevel = await promptThinkingLevel();
  const utilityModel = await chooseUtilityModel(
    modelProvider,
    env,
    model,
    discoveryCache,
  );
  const exploreModel = await chooseExploreModel(
    modelProvider,
    env,
    model,
    thinkingLevel,
    discoveryCache,
  );

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
        ...exploreModel,
        repoResearcher: model,
        ciInvestigator: model,
        releaseReviewer: model,
      },
    },
    paths,
  );
}

export async function chooseExploreModel(
  provider: string,
  env: EnvMap,
  displayModel: string,
  displayThinkingLevel: ThinkingLevel,
  discoveryCache?: ModelDiscoveryCache,
) {
  const mode = await promptSelect<'default' | 'manual'>({
    message: 'Explore subagent model',
    initialValue: 'default',
    options: [
      {
        value: 'default',
        label: 'Use display model',
        hint: `${displayModel} · ${displayThinkingLevel}`,
      },
      {
        value: 'manual',
        label: 'Choose cheap, fast model',
        hint: exploreModelRecommendation,
      },
    ],
  });

  if (mode === 'default') {
    const thinkingLevel = await promptThinkingLevel({
      message: 'Explore thinking level',
      initialValue: 'medium',
    });
    return { explore: null, exploreThinkingLevel: thinkingLevel };
  }
  const model = isCatalogProvider(provider)
    ? await chooseModel(provider, env, discoveryCache, 'explore')
    : await promptModelText(provider, displayModel, 'Explore subagent model');
  const thinkingLevel = await promptThinkingLevel({
    message: 'Explore thinking level',
    initialValue: 'medium',
  });
  return { explore: model, exploreThinkingLevel: thinkingLevel };
}

export async function chooseUtilityModel(
  provider: string,
  env: EnvMap,
  displayModel: string,
  discoveryCache?: ModelDiscoveryCache,
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
  if (isCatalogProvider(provider)) {
    return chooseModel(provider, env, discoveryCache, 'utility');
  }
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
    const { loginOpenAiCodexSubscription } = await reposModule();
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

  if (provider === 'google-vertex') {
    const authMethod = await promptSelect<'api-key' | 'adc'>({
      message: 'Vertex authentication',
      initialValue: env.get('GOOGLE_CLOUD_API_KEY') ? 'api-key' : 'adc',
      options: [
        {
          value: 'api-key',
          label: 'Google Cloud API key',
          hint: 'Simplest setup; project and location are not required.',
        },
        {
          value: 'adc',
          label: 'Application Default Credentials',
          hint: 'Use gcloud user credentials or a service account file.',
        },
      ],
    });

    if (authMethod === 'api-key') {
      const value = await promptPassword({
        message: env.get('GOOGLE_CLOUD_API_KEY')
          ? 'Google Cloud API key (blank keeps existing)'
          : 'Google Cloud API key',
        required: !env.get('GOOGLE_CLOUD_API_KEY'),
      });
      if (value) env.set('GOOGLE_CLOUD_API_KEY', value);
    } else {
      env.delete('GOOGLE_CLOUD_API_KEY');
      const project = await promptText({
        message: 'Google Cloud project id',
        initialValue:
          env.get('GOOGLE_CLOUD_PROJECT') ?? env.get('GCLOUD_PROJECT') ?? '',
        validate: requiredText,
      });
      const location = await promptText({
        message: 'Google Cloud location',
        initialValue: env.get('GOOGLE_CLOUD_LOCATION') ?? 'global',
        validate: requiredText,
      });
      const credentialsPath = await promptText({
        message: 'Service account credentials file',
        placeholder: 'blank uses gcloud application-default credentials',
        initialValue: env.get('GOOGLE_APPLICATION_CREDENTIALS') ?? '',
      });
      env.set('GOOGLE_CLOUD_PROJECT', project.trim());
      env.delete('GCLOUD_PROJECT');
      env.set('GOOGLE_CLOUD_LOCATION', location.trim());
      if (credentialsPath.trim()) {
        env.set('GOOGLE_APPLICATION_CREDENTIALS', credentialsPath.trim());
      } else {
        env.delete('GOOGLE_APPLICATION_CREDENTIALS');
        const defaultAdcPath = join(
          homedir(),
          '.config/gcloud/application_default_credentials.json',
        );
        if (!existsSync(defaultAdcPath)) {
          log.warn(
            'Application Default Credentials were not found. Run `gcloud auth application-default login` before starting Neondeck.',
          );
        }
      }
    }
  } else if (provider === 'kilocode') {
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
    const providerSecret = {
      openai: { key: 'OPENAI_API_KEY', label: 'OpenAI' },
      anthropic: { key: 'ANTHROPIC_API_KEY', label: 'Anthropic' },
      openrouter: { key: 'OPENROUTER_API_KEY', label: 'OpenRouter' },
      opencode: { key: 'OPENCODE_API_KEY', label: 'OpenCode Zen' },
    }[provider];
    if (!providerSecret) return;
    const { key, label } = providerSecret;
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

export async function chooseModel(
  provider: string,
  env: EnvMap,
  discoveryCache: ModelDiscoveryCache = new Map(),
  role: 'displayAssistant' | 'utility' | 'explore' = 'displayAssistant',
) {
  if (!isCatalogProvider(provider)) {
    return promptModelText(provider, defaultProviderModel(provider));
  }

  const { discoverModels, recommendedCatalogModel } =
    await modelDiscoveryModule();
  const spin = spinner();
  const label = providerLabel(provider);
  spin.start(`Discovering ${label} models`);
  let discovery = discoveryCache.get(provider);
  if (!discovery) {
    discovery = discoverModels({
      provider,
      apiKey:
        provider === 'kilocode'
          ? env.get('KILOCODE_API_KEY')
          : provider === 'openrouter'
            ? env.get('OPENROUTER_API_KEY')
            : undefined,
      organizationId:
        provider === 'kilocode'
          ? env.get('KILOCODE_ORGANIZATION_ID')
          : undefined,
    });
    discoveryCache.set(provider, discovery);
  }
  const result = await discovery;
  spin.stop(
    result.ok
      ? `Discovered ${result.models.length} ${label} models`
      : `${label} live discovery unavailable; using ${result.diagnostics.source}`,
  );
  if (result.warning) log.warn(result.warning);
  if (!result.ok && result.error) log.warn(result.error);

  const recommended =
    recommendedCatalogModel(provider, role, result.models) ??
    result.models.find((model) => model.recommendedIndex === 0)?.id;
  const initialModel =
    recommended ?? result.models[0]?.id ?? defaultProviderModel(provider);

  while (true) {
    const mode = await promptSelect<'search' | 'default' | 'manual'>({
      message: `${label} model`,
      initialValue: recommended ? 'default' : 'search',
      options: [
        ...(recommended
          ? [
              {
                value: 'default' as const,
                label: recommended,
                hint: 'Use the recommended default.',
              },
            ]
          : []),
        {
          value: 'search',
          label: 'Search models',
          hint: `Filter discovered ${label} models.`,
        },
        { value: 'manual', label: 'Manual entry' },
      ],
    });

    if (mode === 'default' && recommended) return recommended;
    if (mode === 'manual') {
      return promptCatalogModelText(provider, initialModel, result.models);
    }

    searchModels: while (true) {
      const query = await promptText({
        message: `Search ${label} models`,
        placeholder: 'sonnet, gpt, kimi, free',
      });
      const matches = searchDiscoveredModels(result.models, query);

      if (matches.length === 0) {
        log.warn('No discovered models matched that search.');
        const next = await promptSelect<
          typeof modelSearchAgain | typeof modelSearchBack
        >({
          message: 'No matching models',
          initialValue: modelSearchAgain,
          options: [
            { value: modelSearchAgain, label: 'Search again' },
            { value: modelSearchBack, label: 'Back to model choices' },
          ],
        });
        if (next === modelSearchBack) break;
        continue;
      }

      let page = 0;
      const pageCount = Math.ceil(matches.length / modelSearchPageSize);
      while (true) {
        const start = page * modelSearchPageSize;
        const pageMatches = matches.slice(start, start + modelSearchPageSize);
        const selection = await promptSelect<string>({
          message: `Select model (${start + 1}-${start + pageMatches.length} of ${matches.length})`,
          options: [
            ...pageMatches.map((model) => ({
              value: model.id,
              label: model.id,
              hint: [
                model.name,
                model.contextLength ? `${model.contextLength} ctx` : null,
                model.reasoning ? 'reasoning' : null,
                model.isFree ? 'free' : null,
                model.api,
              ]
                .filter(Boolean)
                .join(' · '),
            })),
            ...(page > 0
              ? [{ value: modelSearchPrevious, label: 'Previous results' }]
              : []),
            ...(page + 1 < pageCount
              ? [{ value: modelSearchNext, label: 'More results' }]
              : []),
            { value: modelSearchAgain, label: 'Search again' },
            { value: modelSearchBack, label: 'Back to model choices' },
          ],
        });
        if (selection === modelSearchPrevious) {
          page -= 1;
          continue;
        }
        if (selection === modelSearchNext) {
          page += 1;
          continue;
        }
        if (selection === modelSearchAgain) continue searchModels;
        if (selection === modelSearchBack) break searchModels;
        return selection;
      }
    }
  }
}

const modelSearchAgain = '__neondeck_search_again__';
const modelSearchBack = '__neondeck_model_choices__';
const modelSearchPrevious = '__neondeck_search_previous__';
const modelSearchNext = '__neondeck_search_next__';
const modelSearchPageSize = 12;

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

async function promptCatalogModelText(
  provider: string,
  initialValue: string,
  models: ModelDiscoveryResult['models'],
): Promise<string> {
  const selected = await promptModelText(provider, initialValue);
  if (models.some((model) => model.id === selected)) return selected;
  log.warn(
    `${selected} is not available in the effective ${providerLabel(provider)} catalog. Choose a discovered model.`,
  );
  return promptCatalogModelText(provider, initialValue, models);
}

function isCatalogProvider(
  provider: string,
): provider is 'kilocode' | 'openrouter' | 'opencode' | 'google-vertex' {
  return (
    provider === 'kilocode' ||
    provider === 'openrouter' ||
    provider === 'opencode' ||
    provider === 'google-vertex'
  );
}

function providerLabel(provider: string) {
  if (provider === 'kilocode') return 'KiloCode';
  if (provider === 'openrouter') return 'OpenRouter';
  if (provider === 'opencode') return 'OpenCode Zen';
  if (provider === 'google-vertex') return 'Google Vertex AI';
  return provider;
}

export async function promptThinkingLevel(
  options: {
    message?: string;
    initialValue?: ThinkingLevel;
  } = {},
) {
  return promptSelect<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>({
    message: options.message ?? 'Thinking level',
    initialValue: options.initialValue ?? 'medium',
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

  if (provider === 'google-vertex') {
    return {
      provider,
      enabled: true,
    };
  }

  return {
    provider,
    enabled: true,
    apiKeyEnv: {
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      opencode: 'OPENCODE_API_KEY',
    }[provider],
  };
}

export function defaultProviderModel(provider: string) {
  if (provider === 'openai') return 'openai/gpt-5.5';
  if (provider === 'openai-codex') return defaultOpenAiCodexModel;
  if (provider === 'anthropic') return 'anthropic/claude-sonnet-4-6';
  if (provider === 'google-vertex') {
    return 'google-vertex/gemini-3.6-flash';
  }
  if (provider === 'openrouter' || provider === 'opencode') {
    return defaultGatewayModel(provider) ?? `${provider}/gpt-5.5`;
  }
  if (provider !== 'kilocode') return `${provider}/gpt-5.5`;
  return defaultModel;
}

export function providerFromModel(model: string): SetupModelProvider {
  const provider = model.includes('/') ? model.split('/')[0] : 'kilocode';
  if (
    provider === 'openai' ||
    provider === 'anthropic' ||
    provider === 'openrouter' ||
    provider === 'opencode' ||
    provider === 'google-vertex' ||
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
      initialValue: 'local-models',
      placeholder: 'local-models',
      validate: openAiCompatibleProviderIdIssue,
    })
  ).trim();
  const baseUrl = (
    await promptText({
      message: 'OpenAI-compatible base URL',
      initialValue: 'https://example.com/v1',
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
        hint: 'Most compatible endpoints.',
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
