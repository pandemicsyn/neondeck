import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import {
  promptConfirm,
  promptSelect,
  promptText,
  requiredText,
} from './prompts';

export async function configureFactoryCoding(current: FactoryCodingConfig) {
  if (
    !(await promptConfirm({
      message: 'Select an installed coding CLI and isolated auth reference?',
      initialValue: false,
    }))
  )
    return current;
  const adapters = listCodingAdapters();
  const id = await promptSelect({
    message: 'Coding adapter (installation and login are separate)',
    options: adapters.map((adapter) => ({
      value: adapter.id,
      label: adapter.label,
      hint: adapter.supportedVersion,
    })),
  });
  const adapter = getCodingAdapter(id);
  const executable = await promptText({
    message: 'Absolute installed executable path',
    initialValue: current.adapter?.id === id ? (current.executable ?? '') : '',
    validate: (value) =>
      value?.startsWith('/') ? undefined : 'Enter an absolute executable path.',
  });
  const model = await promptText({
    message: 'Coding model (adapter-specific model or provider/model)',
    initialValue: current.adapter?.id === id ? (current.model ?? '') : '',
    validate: requiredText,
  });
  const kind = await promptSelect({
    message: 'Isolated credential mechanism',
    options: adapter.credentialKinds.map((value) => ({ value, label: value })),
  });
  const env = await promptText({
    message: 'Credential environment variable name (never the secret value)',
    initialValue: current.auth?.env ?? 'FACTORY_CODING_AUTH',
    validate: (value) =>
      /^[A-Z][A-Z0-9_]{0,127}$/.test(value ?? '')
        ? undefined
        : 'Enter an uppercase environment variable name.',
  });
  const next = v.parse(factoryCodingConfigSchema, {
    ...current,
    adapter: {
      id,
      contractVersion: adapter.contractVersion,
      cliVersion: adapter.supportedVersion,
    },
    executable,
    model,
    auth: { kind, env },
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
      'Isolated credential reference: missing or invalid; set its value in the private runtime environment.',
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
