import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  buildPublishedUpdateManifest,
  manifestChannelIncludesRelease,
  type UpdateManifest,
} from '../src/modules/updates/manifest.ts';

const registryUrl = 'https://registry.npmjs.org/neondeck';
const outputPath = resolve(process.argv[2] ?? 'docs/public/latest.json');
const expectedVersion = process.env.NEONDECK_EXPECTED_RELEASE_VERSION ?? '';
const expectedChannel = process.env.NEONDECK_EXPECTED_RELEASE_CHANNEL ?? '';
if (Boolean(expectedVersion) !== Boolean(expectedChannel)) {
  throw new Error(
    'Expected npm release version and channel must be provided together.',
  );
}
if (
  expectedChannel &&
  expectedChannel !== 'latest' &&
  expectedChannel !== 'next'
) {
  throw new Error(`Invalid expected npm channel ${expectedChannel}.`);
}

const attempts = expectedVersion ? 12 : 1;
let manifest: UpdateManifest | undefined;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  let retryReason = '';
  try {
    const response = await fetch(`${registryUrl}?update=${Date.now()}`, {
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
        'user-agent': 'neondeck-docs-release-manifest',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`npm release metadata returned ${response.status}.`);
    }

    const candidate = buildPublishedUpdateManifest(await response.json());
    if (
      !expectedVersion ||
      (expectedChannel &&
        manifestChannelIncludesRelease(
          candidate,
          expectedChannel,
          expectedVersion,
        ))
    ) {
      manifest = candidate;
      break;
    }
    retryReason = `npm ${expectedChannel} dist-tag has not reached ${expectedVersion}`;
  } catch (error) {
    retryReason = errorMessage(error);
  }

  if (attempt === attempts) {
    throw new Error(
      `Could not generate the expected npm release manifest after ${attempts} attempts: ${retryReason}.`,
    );
  }
  console.log(
    `npm release metadata is pending (attempt ${attempt}/${attempts}: ${retryReason}); retrying in 5 seconds.`,
  );
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
}

if (!manifest) throw new Error('Could not generate the update manifest.');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(
  `Wrote ${outputPath} (latest=${manifest.latest ?? 'none'}, next=${manifest.next ?? 'none'}).`,
);

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
