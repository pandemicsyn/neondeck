import { describe, expect, it } from 'vitest';
import { noWorkspace } from './no-workspace';

describe('noWorkspace', () => {
  it('retains an empty virtual environment without model-facing sandbox tools', async () => {
    const sandbox = noWorkspace();
    const environment = await sandbox.createSessionEnv({ id: 'review-test' });

    expect(environment.cwd).toBe('/workspace');
    expect(await environment.readdir('.')).toEqual([]);
    expect(sandbox.tools?.(environment, { subagents: {} })).toEqual([]);
  });
});
