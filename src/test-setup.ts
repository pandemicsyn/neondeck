import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never let module-level agent metadata initialize or migrate the operator's
// real runtime home during tests. Each Vitest worker gets an isolated home.
process.env.NEONDECK_HOME ??= join(
  tmpdir(),
  `neondeck-vitest-worker-${process.pid}`,
);
process.env.XDG_CONFIG_HOME ??= join(
  tmpdir(),
  `neondeck-vitest-xdg-${process.pid}`,
);

if (process.env.NEONDECK_TEST_UNSIGNED_GIT !== '1') {
  const gitConfigCount = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  const gitConfigEntries = [
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
  ] as const;

  process.env.GIT_CONFIG_COUNT = String(
    gitConfigCount + gitConfigEntries.length,
  );

  gitConfigEntries.forEach(([key, value], index) => {
    const slot = gitConfigCount + index;
    process.env[`GIT_CONFIG_KEY_${slot}`] = key;
    process.env[`GIT_CONFIG_VALUE_${slot}`] = value;
  });

  process.env.NEONDECK_TEST_UNSIGNED_GIT = '1';
}
