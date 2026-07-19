import type { RuntimeStatus } from './types';

let jsonOutput = false;

export function setJsonOutput(enabled: boolean | undefined) {
  jsonOutput = enabled === true;
}

export function isJsonOutput() {
  return jsonOutput;
}

export function printActionResult(result: {
  ok: boolean;
  message: string;
  changed?: boolean;
  errors?: string[];
  warnings?: string[];
  requires?: string[];
}) {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.log(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
  if (result.requires?.length)
    console.log(`requires: ${result.requires.join(', ')}`);
  if (result.warnings?.length) {
    for (const warning of result.warnings) console.log(`warning: ${warning}`);
  }
  if (result.errors?.length) {
    for (const error of result.errors) console.log(`error: ${error}`);
  }
  if (!result.ok) process.exitCode = 1;
}

export function printServiceResult(result: {
  ok: boolean;
  action?: string;
  changed?: boolean;
  message: string;
  status?: {
    platform: string;
    supported: boolean;
    installed: boolean;
    running: boolean;
    pid?: number;
    unitPath: string;
    logPath: string;
    port: number;
    health: { ok: boolean; url: string; status?: number; error?: string };
    nodePath?: string;
    nodePathExists?: boolean;
    serverEntry?: string;
    serverEntryExists?: boolean;
    runtimeHome?: string;
    warnings: string[];
  };
  errors?: string[];
}) {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.log(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
  const status = result.status;
  if (status) {
    console.log(`platform  ${status.platform}`);
    console.log(
      `unit      ${status.installed ? status.unitPath : 'not installed'}`,
    );
    console.log(
      `running   ${status.running ? `yes${status.pid ? ` (pid ${status.pid})` : ''}` : 'no'}`,
    );
    console.log(`port      ${status.port}`);
    console.log(
      `health    ${status.health.ok ? `ok (${status.health.status ?? 200})` : `down (${status.health.error ?? status.health.status ?? 'unknown'})`}`,
    );
    console.log(
      `node      ${status.nodePath ?? 'unknown'}${status.nodePathExists === false ? ' (missing)' : ''}`,
    );
    console.log(
      `entry     ${status.serverEntry ?? 'unknown'}${status.serverEntryExists === false ? ' (missing)' : ''}`,
    );
    console.log(`home      ${status.runtimeHome ?? 'unknown'}`);
    console.log(`logs      ${status.logPath}`);
    for (const warning of status.warnings) console.log(`warning: ${warning}`);
  }
  if (result.errors?.length) {
    for (const error of result.errors) console.log(`error: ${error}`);
  }
  if (!result.ok) process.exitCode = 1;
}

export function printLearningState(
  result: unknown,
  view: 'status' | 'reviews' | 'candidates' | 'events',
) {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result || typeof result !== 'object') {
    console.log('Learning state unavailable.');
    process.exitCode = 1;
    return;
  }
  const state = result as Record<string, unknown>;
  if (state.ok === false) {
    printActionResult({
      ok: false,
      message:
        typeof state.message === 'string'
          ? state.message
          : 'Learning state failed.',
    });
    return;
  }

  const summary = objectField(state.summary);
  if (view === 'status') {
    console.log('learning:ready');
    console.log(`pending   ${numberField(summary, 'pendingDecisions')}`);
    console.log(`failed    ${numberField(summary, 'failedReviews')}`);
    console.log(`memories  ${numberField(summary, 'activeMemories')} active`);
    console.log(`PR events ${numberField(summary, 'handledPrEvents')}`);
  }

  if (view === 'status' || view === 'reviews') {
    const reviews = arrayField(state.reviews);
    if (view === 'reviews') console.log(`reviews ${reviews.length}`);
    for (const review of reviews.slice(
      0,
      view === 'status' ? 5 : reviews.length,
    )) {
      const item = objectField(review);
      console.log(
        `${stringField(item, 'startedAt')} ${stringField(item, 'status').padEnd(9)} ${stringField(item, 'kind').padEnd(12)} ${stringField(item, 'id')}`,
      );
    }
  }

  if (view === 'status' || view === 'candidates') {
    const candidates = arrayField(state.candidates);
    if (view === 'candidates') console.log(`candidates ${candidates.length}`);
    for (const candidate of candidates.slice(
      0,
      view === 'status' ? 8 : candidates.length,
    )) {
      const item = objectField(candidate);
      const label =
        stringField(item, 'skillId') ||
        [stringField(item, 'scope'), stringField(item, 'key')]
          .filter(Boolean)
          .join(':') ||
        stringField(item, 'id');
      console.log(
        `${stringField(item, 'createdAt')} ${stringField(item, 'status').padEnd(9)} ${stringField(item, 'target').padEnd(6)} ${label}`,
      );
      const reason = stringField(item, 'reason');
      if (reason) console.log(`  ${reason}`);
    }
  }

  if (view === 'events') {
    const events = [
      ...arrayField(state.learningEvents),
      ...arrayField(state.memoryEvents),
    ]
      .map(objectField)
      .sort(
        (a, b) =>
          Date.parse(stringField(b, 'createdAt')) -
          Date.parse(stringField(a, 'createdAt')),
      );
    console.log(`events ${events.length}`);
    for (const event of events) {
      const label = stringField(event, 'type') || stringField(event, 'action');
      console.log(
        `${stringField(event, 'createdAt')} ${label.padEnd(26)} ${stringField(event, 'source') || stringField(event, 'actor')}`,
      );
    }
  }
}

export function printRepoDiffResult(result: {
  ok: boolean;
  message: string;
  files?: unknown[];
  diffSummary?: {
    files: number;
    additions: number;
    deletions: number;
    binaryFiles: number;
  };
  errors?: string[];
}) {
  if (jsonOutput || !result.ok) {
    printActionResult(result);
    return;
  }

  console.log(`✓ ${result.message}`);
  const summary = result.diffSummary;
  if (summary) {
    console.log(
      `${summary.files} files, +${summary.additions} -${summary.deletions}, ${summary.binaryFiles} binary`,
    );
  }

  const files = (result.files ?? []).flatMap((file) =>
    repoDiffFileFromUnknown(file),
  );
  if (files.length === 0) {
    console.log('No changes.');
    return;
  }

  for (const file of files) {
    const markers = [
      file.binary ? 'binary' : undefined,
      file.generatedLike ? 'generated' : undefined,
      file.truncated ? 'truncated' : undefined,
    ].filter(Boolean);
    const markerText = markers.length ? ` (${markers.join(', ')})` : '';
    console.log(
      `${file.status.padEnd(10)} +${String(file.additions).padEnd(4)} -${String(file.deletions).padEnd(4)} ${file.path}${markerText}`,
    );
    if (file.patch) console.log(file.patch.trimEnd());
  }
}

export function repoDiffFileFromUnknown(value: unknown) {
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  if (typeof item.path !== 'string' || typeof item.status !== 'string') {
    return [];
  }
  return [
    {
      path: item.path,
      status: item.status,
      additions: typeof item.additions === 'number' ? item.additions : 0,
      deletions: typeof item.deletions === 'number' ? item.deletions : 0,
      binary: item.binary === true,
      generatedLike: item.generatedLike === true,
      patch: typeof item.patch === 'string' ? item.patch : undefined,
      truncated: item.truncated === true,
    },
  ];
}

export function printRepoEditEventsResult(result: {
  ok: boolean;
  message: string;
  events?: Array<{
    id: string;
    repoId: string;
    action: string;
    status: string;
    paths: string[];
    reason: string | null;
    diffSummary: unknown;
    updatedAt: string;
  }>;
  errors?: string[];
}) {
  if (jsonOutput || !result.ok) {
    printActionResult(result);
    return;
  }

  console.log(`✓ ${result.message}`);
  const events = result.events ?? [];
  if (events.length === 0) {
    console.log('No repo edit events recorded.');
    return;
  }

  for (const event of events) {
    const summary = diffSummaryText(event.diffSummary);
    const paths = event.paths.length ? event.paths.join(', ') : '(no paths)';
    const reason = event.reason ? ` · ${event.reason}` : '';
    console.log(
      `${event.updatedAt} ${event.status.padEnd(7)} ${event.action.padEnd(8)} ${event.repoId} ${summary}`,
    );
    console.log(`  ${paths}${reason}`);
  }
}

export function diffSummaryText(value: unknown) {
  if (!value || typeof value !== 'object') return '';
  const summary = value as {
    files?: unknown;
    additions?: unknown;
    deletions?: unknown;
  };
  const files = typeof summary.files === 'number' ? summary.files : 0;
  const additions =
    typeof summary.additions === 'number' ? summary.additions : 0;
  const deletions =
    typeof summary.deletions === 'number' ? summary.deletions : 0;
  return files > 0 ? `${files} files +${additions} -${deletions}` : '';
}

export function printDbMigrationStatus(status: {
  ok: boolean;
  databasePath: string;
  applied: unknown[];
  pending: string[];
  unknown: unknown[];
  changed: unknown[];
  localHead: string | null;
  journalHead: string | null;
  lastBackup: string | null;
  message: string;
}) {
  if (!status.ok) process.exitCode = 1;

  if (jsonOutput) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log(status.ok ? 'db:current' : 'db:attention');
  console.log(`database  ${status.databasePath}`);
  console.log(`head      ${status.journalHead ?? '(none)'}`);
  console.log(`shipped   ${status.localHead ?? '(none)'}`);
  console.log(`applied   ${status.applied.length}`);
  console.log(`pending   ${status.pending.length}`);
  console.log(`unknown   ${status.unknown.length}`);
  console.log(`changed   ${status.changed.length}`);
  console.log(`backup    ${status.lastBackup ?? '(none)'}`);
  console.log(`status    ${status.message}`);
}

export function objectField(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function arrayField(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

export function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'number' ? value : 0;
}

export function printStatus(status: RuntimeStatus) {
  console.log(`neondeck:${status.status}`);
  console.log(`home      ${status.home}`);
  console.log(`env       ${status.paths.env}`);
  console.log(`model     ${status.models.displayAssistant}`);
  console.log(
    `utility  ${status.models.utilityConfigured ? status.models.utility : `${status.models.utility} (fallback)`}`,
  );
  console.log(
    `github    ${status.providers.credentials.github ? 'configured' : 'missing'}`,
  );
  console.log(
    `kilo      ${status.providers.credentials.kilo ? 'configured' : 'missing'}`,
  );
  console.log(
    `openai    ${status.providers.credentials.openai ? 'configured' : 'missing'}`,
  );
  console.log(
    `anthropic ${status.providers.credentials.anthropic ? 'configured' : 'missing'}`,
  );
  console.log(`repos     ${status.counts.repos}`);
  console.log(`skills    ${status.counts.activeSkills}`);
  console.log(`watches   ${status.counts.activeWatches}`);
  console.log(
    `autopilot ${status.autopilot ? `${status.autopilot.status} (${status.autopilot.repoId})` : 'needs a repo'}`,
  );
  const attention = status.checks.filter((check) => !check.ok);
  if (attention.length > 0) {
    console.log('');
    console.log('Needs attention:');
    for (const check of attention)
      console.log(`- ${check.label}: ${check.message}`);
  }
}

export function readConfigData(result: { data?: unknown }) {
  const data = result.data;
  if (!data || typeof data !== 'object') return {};
  const record = data as { config?: unknown };
  if (!record.config || typeof record.config !== 'object') return {};
  return record.config as { skillRoots?: string[] };
}
