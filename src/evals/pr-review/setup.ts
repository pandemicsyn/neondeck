import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Agent statics read runtime configuration at module load. A no-config eval
// run must therefore still have a writable local runtime home so it can report
// its intentionally skipped live case instead of failing during collection.
if (!process.env.NEONDECK_HOME) {
  const home = join(tmpdir(), `neondeck-pr-review-evals-${process.pid}`);
  mkdirSync(home, { recursive: true });
  process.env.NEONDECK_HOME = home;
}
