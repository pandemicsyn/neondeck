import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '@clack/prompts';
import {
  discoverLocalCodexAuth,
  readLocalCodexAuth,
} from '../modules/factory/codex-local-auth';
import {
  codingDiscoveryContext,
  codingExecutionPath,
  discoverCodingExecutable,
  isCodingExecutable,
  validCodingPath,
  validateCodingExecutable,
  type CodingDiscoveryContext,
} from './coding-discovery';
import { pickCodingModel } from './coding-model-picker';
import * as v from 'valibot';
import {
  factoryCodingConfigSchema,
  type FactoryCodingConfig,
} from '../../shared/factory-coding';
import {
  getCodingAdapter,
  inspectCodingAdapterReadiness,
  listCodingAdapters,
} from '../modules/coding-runs';
import {
  localCodingConfig,
  selectedCodingAuth,
} from '../modules/factory/coding-readiness';
import { promptConfirm, promptSelect, promptText } from './prompts';

export async function configureFactoryCoding(
  current: FactoryCodingConfig,
  context: CodingDiscoveryContext = codingDiscoveryContext(),
) {
  if (
    !(await promptConfirm({
      message: 'Set up an installed coding CLI?',
      initialValue: Boolean(current.executable),
    }))
  )
    return current;
  const adapters = listCodingAdapters();
  const detected = new Map(
    await Promise.all(
      adapters.map(
        async (adapter) =>
          [
            adapter.id,
            await discoverCodingExecutable(adapter.id, context),
          ] as const,
      ),
    ),
  );
  const configuredAdapterId = current.executable
    ? (current.adapter?.id ?? 'codex')
    : current.adapter?.id;
  const id = await promptSelect({
    message: 'Coding CLI',
    initialValue:
      configuredAdapterId ??
      adapters.find((adapter) => detected.get(adapter.id))?.id ??
      'codex',
    options: adapters.map((adapter) => ({
      value: adapter.id,
      label: adapter.label,
      hint:
        configuredAdapterId === adapter.id && current.executable
          ? `Configured: ${current.executable}`
          : (detected.get(adapter.id) ?? 'Not detected; enter path manually'),
    })),
  });
  const adapter = getCodingAdapter(id);
  const sameAdapter = (current.adapter?.id ?? 'codex') === id;
  let executable =
    (sameAdapter ? current.executable : null) ?? detected.get(id);
  let path =
    sameAdapter && current.executable
      ? current.path
      : executable
        ? codingExecutionPath(executable, context)
        : current.path;
  if (executable)
    log.info(
      `Coding executable: ${executable}. Search PATH ${sameAdapter && current.executable ? 'retained' : 'auto-detected'}.`,
    );
  const advanced = executable
    ? await promptConfirm({
        message: 'Edit executable or search PATH (advanced)?',
        initialValue: false,
      })
    : true;
  if (advanced) {
    executable = await promptText({
      message: 'Absolute installed executable path',
      initialValue: executable ?? '',
      validate: (value) => validateCodingExecutable(value ?? ''),
    });
    path = await promptText({
      message: 'Executable search PATH (colon-separated absolute directories)',
      initialValue:
        sameAdapter && current.executable
          ? current.path
          : codingExecutionPath(executable, context),
      validate: (value) =>
        validCodingPath(value ?? '')
          ? undefined
          : 'Enter absolute directories with no empty entries or control characters.',
    });
  }
  if (!executable || !(await isCodingExecutable(executable)))
    throw new Error(
      'Coding executable is missing or not executable. Edit its path to continue.',
    );
  if (!validCodingPath(path))
    throw new Error('Invalid executable search PATH.');
  const model = await pickCodingModel(
    id,
    sameAdapter ? current.model : null,
    context.env,
  );
  let auth = sameAdapter ? current.auth : null;
  const local =
    id === 'codex'
      ? discoverLocalCodexAuth({ env: context.env, home: context.home })
      : null;
  const existingEnv = auth && 'env' in auth ? auth.env : null;
  let missingReference =
    existingEnv !== null && !context.env[existingEnv]?.trim();
  if (auth?.kind === 'codex-local') {
    try {
      readLocalCodexAuth(auth.path);
    } catch {
      missingReference = true;
    }
  }
  if (missingReference)
    log.info(
      `${auth?.kind === 'codex-local' ? 'Configured local Codex auth.json cache is missing or invalid.' : `Configured credential reference ${existingEnv} is unavailable.`}${local?.available ? ' A reusable local Codex login is available.' : ''}`,
    );
  const keepAuth = auth
    ? await promptConfirm({
        message: 'Keep the configured isolated credential reference?',
        initialValue: !missingReference,
      })
    : false;
  if (!keepAuth) {
    if (local && !local.available)
      log.info(
        'No reusable file-backed Codex login found. Log in with Codex using auth.json, or select a credential environment reference.',
      );
    const defaultEnv =
      id === 'kilo' ? 'KILOCODE_API_KEY' : 'FACTORY_CODING_AUTH';
    const kind = await promptSelect({
      message:
        'Isolated credential reference (live authentication remains unverified)',
      initialValue: local?.available ? 'codex-local' : 'api-key',
      options: [
        ...(local?.available
          ? [
              {
                value: 'codex-local',
                label: 'Use existing local Codex login',
                hint: local.path,
              },
            ]
          : []),
        ...adapter.credentialKinds.map((value) => ({
          value,
          label: `${value} environment reference${id === 'kilo' && value === 'api-key' ? ' (KILOCODE_API_KEY)' : ' (advanced)'}`,
        })),
      ],
    });
    if (kind === 'codex-local' && local?.available) {
      auth = v.parse(factoryCodingConfigSchema.entries.auth, {
        kind,
        path: local.path,
      });
    } else {
      const env = await promptText({
        message:
          'Credential environment variable name (never the secret value)',
        initialValue: defaultEnv,
        validate: (value) =>
          /^[A-Z][A-Z0-9_]{0,127}$/.test(value ?? '')
            ? undefined
            : 'Enter an uppercase environment variable name.',
      });
      auth = v.parse(factoryCodingConfigSchema.entries.auth, { kind, env });
    }
  }
  const next = v.parse(factoryCodingConfigSchema, {
    ...current,
    adapter: {
      id,
      contractVersion: adapter.contractVersion,
      cliVersion: adapter.supportedVersion,
    },
    executable,
    path,
    model,
    auth,
  });
  if (
    !adapter.acceptsVersion(adapter.supportedVersion, localCodingConfig(next))
  )
    throw new Error('Unsupported coding model or adapter configuration.');
  return next;
}

export async function factoryCodingSetupReadiness(config: FactoryCodingConfig) {
  if (!config.executable || !config.model)
    return ['Coding CLI: not configured; resume with neondeck factory setup.'];
  const adapter = getCodingAdapter(config.adapter?.id ?? 'codex');
  const local = localCodingConfig(config);
  const lines: string[] = [];
  try {
    const auth = selectedCodingAuth(config);
    if (!adapter.credentialKinds.includes(auth.kind))
      throw new Error('Unsupported auth');
    adapter.credentials(auth, local);
    lines.push(
      'Isolated credential reference: locally valid; live authentication unverified.',
    );
  } catch {
    lines.push(
      config.auth?.kind === 'codex-local'
        ? 'Isolated credential reference: selected local Codex auth.json is missing or invalid, or incompatible with the adapter. Restore a valid file-backed login at the selected path or rerun neondeck factory setup to select a replacement. Keyring-only logins cannot be reused; alternatively select a credential environment reference.'
        : 'Isolated credential reference: missing or invalid; set its value in the private runtime environment.',
    );
  }
  const home = await mkdtemp(join(tmpdir(), 'neondeck-factory-setup-'));
  try {
    const result = await inspectCodingAdapterReadiness(local, home);
    lines.push(
      `Coding CLI: ${result.ready ? 'supported installed version' : (result.reason ?? 'unavailable')}; required ${adapter.supportedVersion}.`,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  return lines;
}
