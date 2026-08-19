import { bash, type SandboxFactory } from '@flue/runtime';
import { Bash } from 'just-bash';

/**
 * Keep Flue's lightweight session environment without exposing its generic
 * filesystem and shell tools to the model.
 *
 * Use this for agents whose only model-facing capabilities are bounded custom
 * tools. Application code may still use the session environment if needed.
 */
export function noWorkspace(): SandboxFactory {
  const sandbox = bash(
    () =>
      new Bash({
        cwd: '/workspace',
        commands: [],
      }),
  );
  return {
    ...sandbox,
    tools: () => [],
  };
}
