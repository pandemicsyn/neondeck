import * as v from 'valibot';
import { join } from 'node:path';
import type { LocalManifest } from './host-contract.ts';

// --ignore-user-config skips CODEX_HOME/config.toml; --ignore-rules skips
// execpolicy .rules, not repository SKILL.md discovery (0.150.1 exec --help).
// Installed codex-cli 0.150.1, `exec --help`, verified 2026-09-06. No live model smoke.
export function codexArguments(manifest: LocalManifest) {
  return [
    'exec',
    '--json',
    '--ignore-user-config',
    '--ignore-rules',
    '--color',
    'never',
    '-c',
    'cli_auth_credentials_store="file"',
    '-c',
    'model_provider="openai"',
    '-C',
    manifest.ownedWorktree.root,
    '-m',
    manifest.config.model,
    '-s',
    manifest.config.sandbox,
    '-',
  ];
}
export function codexEnvironment(
  manifest: LocalManifest,
): Record<string, string> {
  const home = join(manifest.directory, 'home');
  return {
    PATH: manifest.config.path,
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: join(manifest.directory, 'scratch'),
    TMP: join(manifest.directory, 'scratch'),
    TEMP: join(manifest.directory, 'scratch'),
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    ...(manifest.config.mockScenario
      ? { MOCKDEX_SCENARIO: manifest.config.mockScenario }
      : {}),
  };
}
const eventSchema = v.object({ type: v.pipe(v.string(), v.minLength(1)) });
const sessionSchema = v.object({
  type: v.literal('thread.started'),
  thread_id: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
});
export class CodexEvents {
  sessionId: string | null = null;
  terminal: 'completed' | 'failed' | null = null;
  private started = false;
  accept(line: string) {
    const parsed: unknown = JSON.parse(line);
    const event = v.parse(eventSchema, parsed);
    if (event.type === 'thread.started') {
      const session = v.parse(sessionSchema, parsed);
      if (this.sessionId !== null) throw new Error('Duplicate Codex session');
      this.sessionId = session.thread_id;
    } else if (event.type === 'turn.started') {
      if (!this.sessionId || this.started)
        throw new Error('Unexpected Codex turn');
      this.started = true;
    } else if (
      event.type === 'turn.completed' ||
      event.type === 'turn.failed'
    ) {
      if (!this.sessionId || !this.started || this.terminal)
        throw new Error('Contradictory Codex terminal event');
      this.terminal = event.type === 'turn.completed' ? 'completed' : 'failed';
    }
  }
}
