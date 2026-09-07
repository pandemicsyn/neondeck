import { log, note } from '@clack/prompts';
import * as v from 'valibot';
import { githubConnectionSchema } from '../../shared/factory-github';
import {
  factoryConfigSchema,
  MAX_FACTORY_GITHUB_CONNECTIONS,
} from '../../shared/factory';
import { readFactoryGitHubRepository } from '../modules/github';
import type { RuntimePaths } from '../runtime-home';
import { connectionReadiness } from '../modules/factory/github-config';
import { loadEnvForPaths } from './options';
import {
  promptConfirm,
  promptSelect,
  promptMultiselect,
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
  const githubResumeHint =
    'GitHub issue intake needs a registered GitHub repository. Run neondeck repo add, then neondeck factory setup. Manual intake remains available in /factory.';
  if (!before.repos.length) log.info(githubResumeHint);
  const intake = await promptSelect({
    message: 'Intake setup',
    options: [
      {
        value: 'manual',
        label: 'Manual dashboard intake',
        hint: 'Existing GitHub connections are retained.',
      },
      ...(before.repos.length
        ? [
            {
              value: 'github',
              label: 'Add GitHub issue connections',
              hint: 'Saved disabled; no remote setup.',
            },
          ]
        : []),
    ],
  });
  if (intake !== 'manual' && intake !== 'github') {
    log.info(
      'Intake selection is unavailable. Factory configuration unchanged. Resume with neondeck factory setup.',
    );
    return;
  }
  if (intake === 'github' && !before.repos.length) {
    log.info(githubResumeHint);
    return;
  }
  const remainingConnections =
    MAX_FACTORY_GITHUB_CONNECTIONS - next.github.length;
  if (intake === 'github' && remainingConnections === 0) {
    log.info(
      `All ${MAX_FACTORY_GITHUB_CONNECTIONS} GitHub connection slots are in use. Review existing connections in /factory before adding more, or rerun neondeck factory setup and choose manual intake to continue setup. Factory configuration unchanged.`,
    );
    return;
  }
  const selectedRepoIds =
    intake === 'github'
      ? await promptMultiselect({
          message: `Repositories for GitHub issue intake (up to ${remainingConnections} new connections)`,
          required: false,
          options: before.repos.map((repo) => ({
            value: repo.id,
            label: `${repo.id} (${repo.github.owner}/${repo.github.name})`,
            hint: next.github.some(
              (connection) => connection.repoId === repo.id,
            )
              ? 'Existing connection retained; no duplicate added.'
              : 'Add a disabled connection.',
          })),
        })
      : [];
  if (
    selectedRepoIds.some((id) => !before.repos.some((repo) => repo.id === id))
  ) {
    log.info(
      'Repository selection is unavailable. Factory configuration unchanged. Resume with neondeck factory setup.',
    );
    return;
  }
  const newRepoIds = [...new Set(selectedRepoIds)].filter(
    (repoId) => !next.github.some((connection) => connection.repoId === repoId),
  );
  if (newRepoIds.length > remainingConnections) {
    log.info(
      `Selected ${newRepoIds.length} new GitHub connections, but only ${remainingConnections} slots remain (limit ${MAX_FACTORY_GITHUB_CONNECTIONS}). Factory configuration unchanged. Rerun neondeck factory setup and select at most ${remainingConnections} new repositories; existing connections are retained and do not use additional slots.`,
    );
    return;
  }
  if (intake === 'github' && !selectedRepoIds.length)
    log.info(
      'No repositories selected. Existing GitHub connections are retained.',
    );
  for (const repoId of new Set(selectedRepoIds)) {
    const repo = before.repos.find((repo) => repo.id === repoId)!;
    if (next.github.some((connection) => connection.repoId === repoId)) {
      log.info(
        `${repoId}: existing GitHub connection retained. Review it in /factory.`,
      );
      continue;
    }
    note(
      `${repoId}: ${repo.github.owner}/${repo.github.name}. This connection will be saved disabled. Metadata lookup is read-only.`,
      'GitHub connection',
    );
    const id = await promptText({
      message: `${repoId}: new connection ID`,
      validate: (value) =>
        /^[A-Za-z0-9_-]+$/.test(value ?? '') &&
        !next.github.some((item) => item.id === value)
          ? undefined
          : 'Use a unique alphanumeric connection ID.',
    });
    const mode = await promptSelect({
      message: `${repoId}: issue admission`,
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
  if (before.factory.coding.enabled)
    log.info('Coding remains enabled. Review coding controls in /factory.');
  else
    log.info(
      'Enabling coding may dispatch existing human-released tasks under existing grants after Apply. Setup creates no release or publication grants.',
    );
  if (!next.enabled)
    log.info(
      'Factory intake is off. Enabled coding will not dispatch until factory intake is enabled.',
    );
  const enableCoding =
    !before.factory.coding.enabled &&
    (await promptConfirm({
      message: 'Enable coding for human-released tasks?',
      initialValue: false,
    }));
  next.coding.enabled = before.factory.coding.enabled || enableCoding;
  const authorization =
    enableCoding && !before.factory.coding.enabled
      ? { enableCoding: true as const }
      : undefined;
  const readiness = await factoryCodingSetupReadiness(next.coding);
  note(
    [
      `Factory intake: ${before.factory.enabled} → ${next.enabled}`,
      `Intake repositories: ${intake === 'manual' ? 'choose per manual task in /factory' : selectedRepoIds.join(', ') || 'no additions'}`,
      `Planning: ${before.models.displayAssistant}; triage: ${before.models.utility}`,
      ...before.modelIssues.map(
        (model) => `Unconfigured provider/model reference: ${model}`,
      ),
      `Coding enabled: ${before.factory.coding.enabled} → ${next.coding.enabled}. Release/publication grants are separate human actions.`,
      ...readiness,
      ...(!next.enabled
        ? [
            'Factory intake is off: coding will not dispatch until factory intake is enabled.',
          ]
        : []),
      'Proposed factory configuration (references only):',
      JSON.stringify(next, null, 2),
      'GitHub webhook: /hooks/github/<connection-id> on the separate ingress listener.',
      'Keep dashboard /factory on the private listener. Setup creates no webhook, provider login or new release/publication grants.',
      ...(next.enabled && next.coding.enabled
        ? [
            'Coding is enabled in this proposal. Applying may let a running server dispatch existing released work under existing grants.',
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
  applyFactorySetup(paths, before.fingerprint, next, authorization);
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
