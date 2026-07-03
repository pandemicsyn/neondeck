import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RuntimeHomeEnv = Partial<
  Pick<NodeJS.ProcessEnv, 'NEONDECK_HOME' | 'XDG_CONFIG_HOME' | 'HOME'>
>;

export type RuntimePaths = {
  home: string;
  env: string;
  config: string;
  repos: string;
  dashboard: string;
  dashboardSchema: string;
  schedules: string;
  soul: string;
  skills: string;
  worktrees: string;
  data: string;
  neondeckDatabase: string;
  flueDatabase: string;
};

export const defaultDashboardPath = fileURLToPath(
  new URL('../../config/dashboard.json', import.meta.url),
);
export const defaultDashboardSchemaPath = fileURLToPath(
  new URL('../../config/dashboard.schema.json', import.meta.url),
);
export const defaultSoulPath = fileURLToPath(
  new URL('../../SOUL.md', import.meta.url),
);

export function resolveRuntimeHome(env: RuntimeHomeEnv = process.env) {
  if (env.NEONDECK_HOME) {
    return expandHome(env.NEONDECK_HOME, env);
  }

  if (env.XDG_CONFIG_HOME) {
    return join(expandHome(env.XDG_CONFIG_HOME, env), 'neondeck');
  }

  return join(env.HOME ?? homedir(), '.config', 'neondeck');
}

export function runtimePaths(home = resolveRuntimeHome()): RuntimePaths {
  return {
    home,
    env: join(home, '.env'),
    config: join(home, 'config.json'),
    repos: join(home, 'repos.json'),
    dashboard: join(home, 'dashboard.json'),
    dashboardSchema: join(home, 'dashboard.schema.json'),
    schedules: join(home, 'schedules.json'),
    soul: join(home, 'SOUL.md'),
    skills: join(home, 'skills'),
    worktrees: join(home, 'worktrees'),
    data: join(home, 'data'),
    neondeckDatabase: join(home, 'data', 'neondeck.db'),
    flueDatabase: join(home, 'data', 'flue.db'),
  };
}

function expandHome(path: string, env: RuntimeHomeEnv) {
  if (path === '~') {
    return env.HOME ?? homedir();
  }

  if (path.startsWith('~/')) {
    return join(env.HOME ?? homedir(), path.slice(2));
  }

  return resolve(path);
}
