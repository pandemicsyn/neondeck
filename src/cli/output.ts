import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import type { readLearningOperatorState } from '../modules/learning';
import type { RepoDiffFile } from '../repo-edit/git';
import type { RuntimeStatus } from './types';

type LearningOperatorStateResult = Awaited<
  ReturnType<typeof readLearningOperatorState>
>;
const cliExternalValueSchema = v.unknown();
type CliExternalValue = v.InferInput<typeof cliExternalValueSchema>;
const cliObjectSchema = v.record(v.string(), cliExternalValueSchema);
const cliArraySchema = v.array(cliExternalValueSchema);
const repoDiffFileSchema: v.GenericSchema<unknown, RepoDiffFile> = v.object({
  path: v.string(),
  previousPath: v.optional(v.nullable(v.string())),
  status: v.string(),
  additions: v.optional(v.number(), 0),
  deletions: v.optional(v.number(), 0),
  binary: v.optional(v.boolean(), false),
  generatedLike: v.optional(v.boolean(), false),
  patch: v.optional(v.string()),
  truncated: v.optional(v.boolean()),
});
const diffSummarySchema = v.object({
  files: v.optional(v.number(), 0),
  additions: v.optional(v.number(), 0),
  deletions: v.optional(v.number(), 0),
});
const configDataSchema = v.object({
  config: v.optional(v.object({ skillRoots: v.optional(v.array(v.string())) })),
});

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
  result: LearningOperatorStateResult,
  view: 'status' | 'reviews' | 'candidates' | 'events',
) {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.ok) {
    printActionResult({
      ok: false,
      message: result.message,
    });
    return;
  }

  const summary = result.summary;
  if (view === 'status') {
    console.log('learning:ready');
    console.log(`pending   ${summary.pendingDecisions}`);
    console.log(`failed    ${summary.failedReviews}`);
    console.log(`memories  ${summary.activeMemories} active`);
    console.log(`PR events ${summary.handledPrEvents}`);
  }

  if (view === 'status' || view === 'reviews') {
    const reviews = result.reviews;
    if (view === 'reviews') console.log(`reviews ${reviews.length}`);
    for (const review of reviews.slice(
      0,
      view === 'status' ? 5 : reviews.length,
    )) {
      console.log(
        `${review.startedAt} ${review.status.padEnd(9)} ${review.kind.padEnd(12)} ${review.id}`,
      );
    }
  }

  if (view === 'status' || view === 'candidates') {
    const candidates = result.candidates;
    if (view === 'candidates') console.log(`candidates ${candidates.length}`);
    for (const candidate of candidates.slice(
      0,
      view === 'status' ? 8 : candidates.length,
    )) {
      const label =
        candidate.skillId ||
        [candidate.scope, candidate.key].filter(Boolean).join(':') ||
        candidate.id;
      console.log(
        `${candidate.createdAt} ${candidate.status.padEnd(9)} ${candidate.target.padEnd(6)} ${label}`,
      );
      const reason = candidate.reason;
      if (reason) console.log(`  ${reason}`);
    }
  }

  if (view === 'events') {
    const events = [...result.learningEvents, ...result.memoryEvents].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    console.log(`events ${events.length}`);
    for (const event of events) {
      const label = 'type' in event ? event.type : event.action;
      const source = 'source' in event ? event.source : event.actor;
      console.log(`${event.createdAt} ${label.padEnd(26)} ${source}`);
    }
  }
}

export function printRepoDiffResult(result: {
  ok: boolean;
  message: string;
  files?: CliExternalValue[];
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

export function repoDiffFileFromUnknown(value: CliExternalValue) {
  const parsed = v.safeParse(repoDiffFileSchema, value);
  return parsed.success ? [parsed.output] : [];
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

export function diffSummaryText(value: CliExternalValue) {
  const summary = v.safeParse(diffSummarySchema, value);
  if (!summary.success || summary.output.files === 0) return '';
  return `${summary.output.files} files +${summary.output.additions} -${summary.output.deletions}`;
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

type DbBackup = {
  name: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  walBytes: number | null;
  shmBytes: number | null;
  kind: string;
};

export function printDbBackupResult(result: {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  backup?: DbBackup;
  restoredBackup?: DbBackup;
  safetyBackup?: DbBackup;
  errors?: string[];
  warnings?: string[];
}) {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.log(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
  if (result.backup) printDbBackupMetadata('backup', result.backup);
  if (result.restoredBackup)
    printDbBackupMetadata('restored', result.restoredBackup);
  if (result.safetyBackup) printDbBackupMetadata('safety', result.safetyBackup);
  if (result.errors?.length) {
    for (const error of result.errors) console.log(`error: ${error}`);
  }
  if (result.warnings?.length) {
    for (const warning of result.warnings) console.log(`warning: ${warning}`);
  }
  if (!result.ok) process.exitCode = 1;
}

export function printDbBackups(backups: DbBackup[]) {
  const result = { ok: true, action: 'db_backups', backups };
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (backups.length === 0) {
    console.log('No recognized app database backups.');
    return;
  }

  for (const backup of backups) {
    console.log(
      `${backup.createdAt} ${backup.kind.padEnd(14)} ${formatBytes(backup.sizeBytes).padStart(9)} ${backup.name}`,
    );
  }
}

function printDbBackupMetadata(label: string, backup: DbBackup) {
  console.log(`${label}    ${backup.path}`);
  console.log(`created   ${backup.createdAt}`);
  console.log(`size      ${formatBytes(backup.sizeBytes)}`);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function objectField(value: CliExternalValue) {
  const parsed = v.safeParse(cliObjectSchema, value);
  return parsed.success && !Array.isArray(value) ? parsed.output : {};
}

export function arrayField(value: CliExternalValue) {
  const parsed = v.safeParse(cliArraySchema, value);
  return parsed.success ? parsed.output : [];
}

export function stringField(
  record: v.InferOutput<typeof cliObjectSchema>,
  key: string,
) {
  const value = v.safeParse(v.string(), record[key]);
  return value.success ? value.output : '';
}

export function numberField(
  record: v.InferOutput<typeof cliObjectSchema>,
  key: string,
) {
  const value = v.safeParse(v.number(), record[key]);
  return value.success ? value.output : 0;
}

export function printStatus(status: RuntimeStatus) {
  console.log(`neondeck:${status.status}`);
  console.log(`home      ${status.home}`);
  console.log(`env       ${status.paths.env}`);
  console.log(`model     ${status.models.displayAssistant}`);
  console.log(
    `review    ${status.models.prReviewConfigured ? status.models.prReview : `${status.models.prReview} (fallback)`} · ${Math.round(status.models.prReviewTimeoutMs / 1000)}s`,
  );
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
    `chatgpt   ${status.providers.credentials.openaiCodex ? 'configured' : 'missing'}`,
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

export function readConfigData(result: { data?: JsonValue }) {
  const parsed = v.safeParse(configDataSchema, result.data);
  return parsed.success ? (parsed.output.config ?? {}) : {};
}
