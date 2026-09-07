import { log, note } from '@clack/prompts';
import * as v from 'valibot';
import { githubConnectionSchema } from '../../shared/factory-github';
import { factoryConfigSchema } from '../../shared/factory';
import { readFactoryGitHubRepository } from '../modules/github';
import type { RuntimePaths } from '../runtime-home';
import { connectionReadiness } from '../modules/factory/github-config';
import { loadEnvForPaths } from './options';
import {
  promptConfirm,
  promptSelect,
  promptText,
  requiredText,
} from './prompts';
import {
  applyFactorySetup,
  readFactorySetup,
} from './onboarding-factory-state';
import {
  configureFactoryCoding,
  factoryCodingSetupReadiness,
} from './onboarding-factory-coding';

export async function configureFactory(paths: RuntimePaths) {
  if (
    !(await promptConfirm({
      message: 'Set up optional factory intake now?',
      initialValue: false,
    }))
  ) {
    log.info(
      'Factory setup skipped. Resume with neondeck factory setup; open /factory in the dashboard.',
    );
    return;
  }
  loadEnvForPaths(paths, { includeDevFallback: false });
  const before = readFactorySetup(paths);
  const next = v.parse(factoryConfigSchema, before.factory);
  if (!next.enabled)
    next.enabled = await promptConfirm({
      message:
        'Enable factory intake? A running server may triage admitted work with the utility model.',
      initialValue: false,
    });
  const intake = await promptSelect({
    message: 'Intake setup',
    options: [
      {
        value: 'manual',
        label: 'Manual dashboard intake',
        hint: 'Existing GitHub connections are retained.',
      },
      {
        value: 'github',
        label: 'Add GitHub issue connection',
        hint: 'Saved disabled; no remote setup.',
      },
    ],
  });
  let repoId: string | undefined;
  if (before.repos.length)
    repoId = await promptSelect({
      message:
        'Repository for intake (manual tasks select it again in /factory)',
      options: before.repos.map((repo) => ({ value: repo.id, label: repo.id })),
    });
  else if (intake === 'github')
    throw new Error(
      'Register a repository with neondeck repo add before GitHub setup.',
    );
  if (intake === 'github') {
    const repo = before.repos.find((repo) => repo.id === repoId)!;
    const id = await promptText({
      message: 'New connection ID',
      validate: (value) =>
        /^[A-Za-z0-9_-]+$/.test(value ?? '') &&
        !next.github.some((item) => item.id === value)
          ? undefined
          : 'Use a unique alphanumeric connection ID.',
    });
    const mode = await promptSelect({
      message: 'Issue admission',
      options: [
        { value: 'label', label: 'Require a label' },
        { value: 'all', label: 'All issues' },
      ],
    });
    const label =
      mode === 'label'
        ? await promptText({
            message: 'Admission label',
            validate: requiredText,
          })
        : undefined;
    const reference = async (message: string, initialValue: string) =>
      promptText({
        message,
        initialValue,
        validate: (value) =>
          /^[A-Z][A-Z0-9_]*$/.test(value ?? '')
            ? undefined
            : 'Enter an environment variable name, not a value.',
      });
    const connection = v.parse(githubConnectionSchema, {
      id,
      enabled: false,
      repoId,
      repositoryId: '1', // Temporary identity used only for the metadata read below.
      owner: repo.github.owner,
      name: repo.github.name,
      admission: { mode, ...(label ? { label } : {}) },
      webhookSecretEnv: await reference(
        'Webhook secret environment reference',
        'FACTORY_GITHUB_WEBHOOK_SECRET',
      ),
      tokenEnv: await reference(
        'GitHub read token environment reference',
        'GITHUB_TOKEN',
      ),
    });
    try {
      if (!process.env[connection.tokenEnv]) throw new Error('missing-token');
      const metadata = await readFactoryGitHubRepository(connection);
      if (
        metadata.owner.login.toLowerCase() !== connection.owner.toLowerCase() ||
        metadata.name.toLowerCase() !== connection.name.toLowerCase()
      )
        throw new Error('repository-mismatch');
      connection.repositoryId = v.parse(
        githubConnectionSchema.entries.repositoryId,
        String(metadata.id),
      );
    } catch {
      note(
        `Repository metadata lookup failed. Check ${connection.tokenEnv} in the selected runtime home's .env and repository read access. No connection has been saved.`,
        'GitHub lookup',
      );
      if (
        !(await promptConfirm({
          message: 'Enter a known numeric repository ID manually instead?',
          initialValue: false,
        }))
      )
        return;
      connection.repositoryId = await promptText({
        message: 'Known numeric GitHub repository ID',
        validate: (value) =>
          /^[1-9][0-9]*$/.test(value ?? '')
            ? undefined
            : 'Enter a positive numeric repository ID.',
      });
    }
    next.github.push(connection);
  }
  next.coding = await configureFactoryCoding(next.coding);
  const readiness = await factoryCodingSetupReadiness(next.coding);
  note(
    [
      `Factory intake: ${before.factory.enabled} → ${next.enabled}`,
      `Selected repository: ${repoId ?? 'choose when creating a manual task'}`,
      `Planning: ${before.models.displayAssistant}; triage: ${before.models.utility}`,
      ...before.modelIssues.map(
        (model) => `Unconfigured provider/model reference: ${model}`,
      ),
      `Coding enabled: ${next.coding.enabled} (retained). Release/publication grants are separate human actions.`,
      ...readiness,
      'Proposed factory configuration (references only):',
      JSON.stringify(next, null, 2),
      'GitHub webhook: /hooks/github/<connection-id> on the separate ingress listener.',
      'Keep dashboard /factory on the private listener. Setup creates no webhook, provider login or new release/publication grants.',
      ...(next.enabled && next.coding.enabled
        ? [
            'WARNING: Coding is already enabled. Applying intake enablement may let a running server dispatch existing released work under existing grants.',
          ]
        : []),
      'Changing existing coding settings can invalidate outstanding grants; review them in /factory.',
    ].join('\n'),
    'Review factory setup',
  );
  if (
    !(await promptConfirm({
      message: 'Apply this local factory configuration?',
      initialValue: false,
    }))
  ) {
    log.info('Factory configuration unchanged.');
    return;
  }
  applyFactorySetup(paths, before.fingerprint, next);
  const lines = next.github.flatMap((connection) =>
    connectionReadiness(connection, paths).map(
      (reason) => `${connection.id}: ${reason}`,
    ),
  );
  note(
    [
      ...readiness,
      ...lines,
      'Open /factory in the dashboard. Enable new GitHub connections there after reviewing readiness.',
      `Set missing referenced values in ${paths.env} (private; never commit it), then restart the server.`,
      'Webhook routing: set NEONDECK_INGRESS_PORT to a separate port; send issues and issue_comment events to /hooks/github/<connection-id>. Keep /factory on the private dashboard listener.',
    ].join('\n'),
    'Factory setup saved',
  );
}
