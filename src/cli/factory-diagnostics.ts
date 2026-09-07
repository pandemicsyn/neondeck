import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import * as v from 'valibot';
import {
  factoryDiagnosticExportSchema,
  type FactoryHealth,
} from '../../shared/factory-diagnostics';
import {
  getFactoryDiagnosticsHealth,
  getFactoryTaskTimeline,
  previewFactoryDiagnostics,
} from '../modules/factory-diagnostics';
import { pathsFromOptions } from './options';
import type { GlobalOptions } from './types';

const maxExportBytes = 2_000_000;
const localPath = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(4096),
  v.check(
    (p) => !p.includes('\0') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(p),
    'A local file path is required.',
  ),
);
export async function writeFactoryDiagnosticPreview(
  previewFile: unknown,
  outputFile: unknown,
) {
  const input = v.parse(localPath, previewFile),
    output = v.parse(localPath, outputFile);
  const file = await open(
    input,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  let bytes: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxExportBytes)
      throw new Error(
        'Diagnostic preview must be a regular file of at most 2 MB.',
      );
    const buffer = Buffer.alloc(maxExportBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (size > maxExportBytes)
      throw new Error('Diagnostic preview exceeds 2 MB.');
    bytes = buffer.subarray(0, size);
  } finally {
    await file.close();
  }
  // Validate without reserialization: the bytes the operator previewed are exactly the bytes written.
  const parsed = v.parse(
    factoryDiagnosticExportSchema,
    JSON.parse(bytes.toString('utf8')),
  );
  const canonical = JSON.stringify(parsed, null, 2);
  if (
    !bytes.equals(Buffer.from(canonical)) &&
    !bytes.equals(Buffer.from(`${canonical}\n`))
  ) {
    throw new Error(
      'Preview must be the exact canonical JSON produced by diagnostics preview; unknown fields and duplicate keys are not accepted.',
    );
  }
  await writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
}
export function registerFactoryCommands(factoryCommand: Command) {
  const paths = () =>
    pathsFromOptions(factoryCommand.optsWithGlobals<GlobalOptions>());
  factoryCommand
    .command('doctor')
    .description(
      'Read local factory health; never starts workers or contacts GitHub.',
    )
    .option('--work-id <id>', 'Limit diagnosis to one task.')
    .action(async (options: { workId?: string }) => {
      const health = getFactoryDiagnosticsHealth(await paths(), options.workId);
      console.log(
        factoryCommand.optsWithGlobals<GlobalOptions>().json
          ? JSON.stringify(health, null, 2)
          : formatFactoryDoctor(health),
      );
    });
  factoryCommand
    .command('timeline <workId>')
    .description('Read bounded retained task history.')
    .option('--limit <count>', 'Page size (1–100).', '25')
    .option('--cursor <cursor>', 'Continue an unchanged timeline snapshot.')
    .action(
      async (workId: string, options: { limit: string; cursor?: string }) => {
        console.log(
          JSON.stringify(
            getFactoryTaskTimeline(
              workId,
              {
                limit: Number(options.limit),
                ...(options.cursor ? { cursor: options.cursor } : {}),
              },
              await paths(),
            ),
            null,
            2,
          ),
        );
      },
    );
  const diagnostics = factoryCommand
    .command('diagnostics')
    .description(
      'Preview and write a redacted local task diagnostic snapshot.',
    );
  diagnostics
    .command('preview <workId>')
    .description(
      'Print exact safe JSON; save stdout to a local preview file and inspect it before export.',
    )
    .action(async (workId: string) => {
      console.log(
        JSON.stringify(
          previewFactoryDiagnostics(workId, await paths()),
          null,
          2,
        ),
      );
    });
  diagnostics
    .command('export <previewFile> <outputFile>')
    .description(
      'Validate and write the exact previously previewed JSON bytes locally; refuses to overwrite.',
    )
    .action(async (previewFile: string, outputFile: string) => {
      await writeFactoryDiagnosticPreview(previewFile, outputFile);
      console.log(JSON.stringify({ written: true }));
    });
}

export function formatFactoryDoctor(health: FactoryHealth) {
  const lines = [`Factory: ${health.status}`, health.summary];
  for (const worker of health.workers) {
    lines.push(
      `${worker.worker}: ${worker.status}; last success ${worker.lastSuccessAt ?? 'not recorded'}; next tick ${worker.nextTickAt ?? 'not scheduled'}`,
    );
    lines.push(`  Consecutive failures: ${worker.consecutiveFailures}`);
    if (worker.lastError)
      lines.push(
        `  Last error: ${worker.lastError.class}/${worker.lastError.code}`,
      );
    if (worker.diagnosticsDegraded)
      lines.push(
        '  Diagnostic storage degraded: some diagnostic records could not be retained. Check local storage and database access.',
      );
  }
  for (const task of health.tasks) {
    lines.push(`${task.workId}: ${task.status}`, `  Next: ${task.nextStep}`);
    if (task.pendingAgeMs !== null)
      lines.push(`  Pending age: ${Math.floor(task.pendingAgeMs / 1000)}s`);
    if (task.nextRetryAt) lines.push(`  Recorded retry: ${task.nextRetryAt}`);
    if (task.unresolvedEffects.length)
      lines.push(`  Unresolved effects: ${task.unresolvedEffects.length}`);
    for (const budget of task.budgets)
      lines.push(
        `  ${budget.deliveryId}: ${budget.remainingExecutionMs}ms remaining; ${budget.repairsRemaining} repairs remaining`,
      );
  }
  if (health.truncated)
    lines.push(
      'Bounded diagnosis: additional records were omitted. Inspect the selected task for details.',
    );
  return lines.join('\n');
}
