import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import {
  type AppConfig,
  type ExecutionBackend,
  type ExecutionConfig,
  type ExecutionPreapprovedCommand,
  type RuntimePaths,
  ensureRuntimeHome,
  ensureRuntimeHomeSync,
  executionConfigSchema,
  parseAppConfig,
  readRuntimeJson,
  readRuntimeJsonSync,
  runtimePaths,
} from './runtime-home';

export type ExecutionContext = 'interactive' | 'unattended';
export type ExecutionDecision = 'allow' | 'ask' | 'deny';
export type ExecutionRisk =
  'read-only' | 'safe-mutation' | 'destructive-mutation' | 'hardline';

export type ExecutionPolicy = {
  ok: boolean;
  action: 'execution_policy_read';
  version: number;
  defaultBackend: ExecutionBackend;
  enabledBackends: ExecutionBackend[];
  supportedBackends: ExecutionBackend[];
  approvalMode: 'manual' | 'off';
  unattended: 'deny' | 'allow-preapproved';
  preapprovedCommands: NormalizedPreapprovedCommand[];
  defaults: {
    localAccess: boolean;
    exeDevPlanned: boolean;
    shellOperatorsPreapproved: boolean;
    hardlineBypassable: boolean;
  };
  notes: string[];
  fetchedAt: string;
};

export type ExecutionPolicyCheck = {
  ok: boolean;
  action: 'execution_policy_check';
  changed: false;
  command: string;
  backend: ExecutionBackend;
  context: ExecutionContext;
  decision: ExecutionDecision;
  risk: ExecutionRisk;
  reason: string;
  matchedPreapproval?: NormalizedPreapprovedCommand;
  requires?: string[];
};

export type NormalizedPreapprovedCommand = {
  id: string;
  command: string;
  match: 'exact' | 'prefix' | 'glob';
  backends: ExecutionBackend[];
  description: string;
};

export const executionPolicyUpdateSchema = v.partial(executionConfigSchema);

const executionPolicyCheckInputSchema = v.object({
  command: v.pipe(v.string(), v.minLength(1)),
  backend: v.optional(v.picklist(['local', 'exe.dev'])),
  context: v.optional(v.picklist(['interactive', 'unattended'])),
});

const executionPolicyOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
});

const supportedBackends: ExecutionBackend[] = ['local', 'exe.dev'];
const hardlineDescriptions = [
  'recursive delete of root, home, or system directories',
  'filesystem format commands',
  'raw block-device overwrite',
  'system shutdown or reboot',
  'fork bomb',
  'kill every process',
  'sudo password guessing via stdin',
];
const defaultPreapprovals: NormalizedPreapprovedCommand[] = [
  preapproval('pwd', 'pwd', 'exact', 'Current working directory.'),
  preapproval(
    'git-status-short',
    'git status --short',
    'exact',
    'Short git working tree status.',
  ),
  preapproval(
    'git-status-branch-short',
    'git status --branch --short',
    'exact',
    'Short git working tree status with branch.',
  ),
  preapproval(
    'git-branch-current',
    'git branch --show-current',
    'exact',
    'Current git branch name.',
  ),
  preapproval(
    'git-root',
    'git rev-parse --show-toplevel',
    'exact',
    'Current git repository root.',
  ),
  preapproval(
    'git-diff-stat',
    'git diff --stat',
    'exact',
    'Git diff file statistics.',
  ),
  preapproval(
    'git-diff-name-only',
    'git diff --name-only',
    'exact',
    'Changed file names.',
  ),
  preapproval(
    'git-log-oneline',
    'git log --oneline -n *',
    'glob',
    'Bounded one-line git log.',
  ),
  preapproval('gh', 'gh', 'prefix', 'Run GitHub CLI commands.'),
];

const hardlinePatterns: Array<[RegExp, string]> = [
  [
    /\brm\s+(-[^\s]*\s+)*(\/|\/\*|\/home|\/home\/\*|\/root|\/root\/\*|\/etc|\/etc\/\*|\/usr|\/usr\/\*|\/var|\/var\/\*|~|\$HOME)(\s|$)/i,
    'recursive delete of root, home, or system directory',
  ],
  [/\bmkfs(\.[a-z0-9]+)?\b/i, 'filesystem format command'],
  [
    /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*/i,
    'raw block-device overwrite',
  ],
  [
    />\s*\/dev\/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\b/i,
    'raw block-device redirect',
  ],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork bomb'],
  [/\bkill\s+(-[^\s]+\s+)*-1\b/i, 'kill every process'],
  [
    /(?:^|[;&|\n`]|\$\()\s*(sudo\s+)?(shutdown|reboot|halt|poweroff)\b/i,
    'system shutdown or reboot',
  ],
  [/(?:^|[;&|\n`]|\$\()\s*sudo\s+-S\b/i, 'sudo password guessing via stdin'],
];

const destructivePatterns = [
  /\brm\s+(-[^\s]*\s+)*[^/]/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-/i,
  /\bchmod\s+(-[^\s]*\s+)*777\b/i,
  /\b(curl|wget)\b[^\n]*(\|\s*(sh|bash)|>\s*)/i,
];
const safeMutationPatterns = [
  /\bgit\s+(fetch|pull|checkout|switch|merge|rebase)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(install|run|test|exec)\b/i,
];
const readOnlyPatterns = [
  /^(pwd|ls\b|git\s+(status|diff|log|show|branch|rev-parse)\b)/i,
  /^gh\s+(pr\s+(view|checks|diff)|run\s+view)\b/i,
];

export const executionPolicyLookupTool = defineTool({
  name: 'neondeck_execution_policy_lookup',
  description:
    'Read Neondeck host execution approval policy, preapproved command defaults, and supported execution backends.',
  input: v.object({}),
  output: executionPolicyOutputSchema,
  async run() {
    return readExecutionPolicy();
  },
});

export const executionPolicyCheckAction = defineAction({
  name: 'neondeck_execution_policy_check',
  description:
    'Classify a proposed local or exe.dev command against the Neondeck execution approval policy without running it.',
  input: executionPolicyCheckInputSchema,
  output: executionPolicyOutputSchema,
  async run({ input }) {
    return checkExecutionPolicy(input);
  },
});

export async function readExecutionPolicy(
  paths: RuntimePaths = runtimePaths(),
): Promise<ExecutionPolicy> {
  await ensureRuntimeHome(paths);
  const config = await readRuntimeJson(paths.config, parseAppConfig);
  return executionPolicyFromConfig(config);
}

export function readExecutionPolicySync(
  paths: RuntimePaths = runtimePaths(),
): ExecutionPolicy {
  ensureRuntimeHomeSync(paths);
  const config = readRuntimeJsonSync(paths.config, parseAppConfig);
  return executionPolicyFromConfig(config);
}

export async function checkExecutionPolicy(
  rawInput: v.InferInput<typeof executionPolicyCheckInputSchema>,
  paths: RuntimePaths = runtimePaths(),
): Promise<ExecutionPolicyCheck> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(executionPolicyCheckInputSchema, rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      action: 'execution_policy_check',
      changed: false,
      command: '',
      backend: 'local',
      context: 'interactive',
      decision: 'deny',
      risk: 'hardline',
      reason: `Invalid execution policy check input: ${v.summarize(parsed.issues)}`,
      requires: ['command'],
    };
  }

  const policy = await readExecutionPolicy(paths);
  const command = parsed.output.command.trim();
  const backend = parsed.output.backend ?? policy.defaultBackend;
  const context = parsed.output.context ?? 'interactive';
  const hardline = detectHardline(command);

  if (!policy.enabledBackends.includes(backend)) {
    return checkResult(command, backend, context, 'deny', 'hardline', {
      reason: `Execution backend "${backend}" is not enabled in config.json.`,
      requires: ['enabledBackends'],
    });
  }

  if (hardline) {
    return checkResult(command, backend, context, 'deny', 'hardline', {
      reason: `Hardline block: ${hardline}. Run it manually outside Neon if you really need it.`,
    });
  }

  const risk = classifyCommand(command);
  const matchedPreapproval = findPreapproval(command, backend, policy);
  if (matchedPreapproval) {
    return checkResult(command, backend, context, 'allow', risk, {
      reason: `Matched preapproved command "${matchedPreapproval.id}".`,
      matchedPreapproval,
    });
  }

  if (policy.approvalMode === 'off') {
    return checkResult(command, backend, context, 'allow', risk, {
      reason:
        'Execution approval mode is off. Hardline blocks still apply; this should only be used in trusted local profiles.',
    });
  }

  if (context === 'unattended') {
    return checkResult(command, backend, context, 'deny', risk, {
      reason:
        'Command is not preapproved. Unattended host execution defaults to deny.',
      requires: ['preapprovedCommands'],
    });
  }

  return checkResult(command, backend, context, 'ask', risk, {
    reason:
      'Command is not preapproved. Interactive host execution requires user approval before running.',
    requires: ['approval'],
  });
}

export function executionPolicyFromConfig(
  config: Pick<AppConfig, 'execution'>,
) {
  const raw = config.execution ?? {};
  const defaultBackend = raw.defaultBackend ?? 'local';
  const enabledBackends = uniqueBackends(raw.enabledBackends ?? ['local']);
  const policy: ExecutionPolicy = {
    ok: true,
    action: 'execution_policy_read',
    version: 1,
    defaultBackend,
    enabledBackends,
    supportedBackends,
    approvalMode: raw.approvalMode ?? 'manual',
    unattended: raw.unattended ?? 'deny',
    preapprovedCommands: [
      ...defaultPreapprovals,
      ...normalizePreapprovals(raw.preapprovedCommands ?? []),
    ],
    defaults: {
      localAccess: enabledBackends.includes('local'),
      exeDevPlanned: true,
      shellOperatorsPreapproved: false,
      hardlineBypassable: false,
    },
    notes: [
      'This policy is an approval gate for neondeck_execution_run. It does not run commands by itself.',
      'The local backend is the default execution target. exe.dev uses the Flue sandbox adapter against an existing VM when EXE_VM_HOST or execution.exeDev.vmHostEnv is configured.',
      'Preapproved commands must be single commands without shell operators. Hardline blocks cannot be preapproved.',
      'Any command not matched by the preapproval list requires interactive approval or is denied in unattended contexts.',
    ],
    fetchedAt: new Date().toISOString(),
  };

  if (!policy.enabledBackends.includes(policy.defaultBackend)) {
    policy.enabledBackends = uniqueBackends([
      policy.defaultBackend,
      ...policy.enabledBackends,
    ]);
  }

  return policy;
}

export function mergeExecutionConfig(
  current: ExecutionConfig | undefined,
  input: v.InferOutput<typeof executionPolicyUpdateSchema>,
): ExecutionConfig {
  return {
    ...(current ? current : {}),
    ...(input.defaultBackend !== undefined
      ? { defaultBackend: input.defaultBackend }
      : {}),
    ...(input.enabledBackends !== undefined
      ? { enabledBackends: uniqueBackends(input.enabledBackends) }
      : {}),
    ...(input.approvalMode !== undefined
      ? { approvalMode: input.approvalMode }
      : {}),
    ...(input.unattended !== undefined ? { unattended: input.unattended } : {}),
    ...(input.preapprovedCommands !== undefined
      ? { preapprovedCommands: input.preapprovedCommands }
      : {}),
    ...(input.exeDev !== undefined ? { exeDev: input.exeDev } : {}),
  };
}

export function hasExecutionPolicyUpdate(
  input: v.InferOutput<typeof executionPolicyUpdateSchema>,
) {
  return (
    input.defaultBackend !== undefined ||
    input.enabledBackends !== undefined ||
    input.approvalMode !== undefined ||
    input.unattended !== undefined ||
    input.preapprovedCommands !== undefined ||
    input.exeDev !== undefined
  );
}

export function defaultExecutionPreapprovals() {
  return defaultPreapprovals.map((item) => ({ ...item }));
}

export function asExecutionPolicyData(policy: ExecutionPolicy): JsonValue {
  return JSON.parse(JSON.stringify(policy)) as JsonValue;
}

function checkResult(
  command: string,
  backend: ExecutionBackend,
  context: ExecutionContext,
  decision: ExecutionDecision,
  risk: ExecutionRisk,
  details: {
    reason: string;
    matchedPreapproval?: NormalizedPreapprovedCommand;
    requires?: string[];
  },
): ExecutionPolicyCheck {
  return {
    ok: decision !== 'deny',
    action: 'execution_policy_check',
    changed: false,
    command,
    backend,
    context,
    decision,
    risk,
    reason: details.reason,
    ...(details.matchedPreapproval
      ? { matchedPreapproval: details.matchedPreapproval }
      : {}),
    ...(details.requires ? { requires: details.requires } : {}),
  };
}

function preapproval(
  id: string,
  command: string,
  match: NormalizedPreapprovedCommand['match'],
  description: string,
): NormalizedPreapprovedCommand {
  return {
    id,
    command,
    match,
    backends: ['local', 'exe.dev'],
    description,
  };
}

function normalizePreapprovals(
  commands: ExecutionPreapprovedCommand[],
): NormalizedPreapprovedCommand[] {
  return commands.map((item, index) => ({
    id: item.id ?? `custom-${index + 1}`,
    command: item.command.trim(),
    match: item.match ?? 'exact',
    backends: uniqueBackends(item.backends ?? ['local']),
    description: item.description ?? 'Configured preapproved command.',
  }));
}

function uniqueBackends(backends: ExecutionBackend[]) {
  return supportedBackends.filter((backend) => backends.includes(backend));
}

function findPreapproval(
  command: string,
  backend: ExecutionBackend,
  policy: ExecutionPolicy,
) {
  if (hasShellOperator(command)) return undefined;
  return policy.preapprovedCommands.find(
    (item) =>
      item.backends.includes(backend) && preapprovalMatches(command, item),
  );
}

function preapprovalMatches(
  command: string,
  item: NormalizedPreapprovedCommand,
) {
  if (item.match === 'exact') return command === item.command;
  if (item.match === 'prefix') {
    return command === item.command || command.startsWith(`${item.command} `);
  }
  return globToRegExp(item.command).test(command);
}

function globToRegExp(pattern: string) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`);
}

function detectHardline(command: string) {
  for (const [pattern, description] of hardlinePatterns) {
    if (pattern.test(command)) return description;
  }

  return undefined;
}

function classifyCommand(command: string): ExecutionRisk {
  if (detectHardline(command)) return 'hardline';
  if (destructivePatterns.some((pattern) => pattern.test(command))) {
    return 'destructive-mutation';
  }
  if (safeMutationPatterns.some((pattern) => pattern.test(command))) {
    return 'safe-mutation';
  }
  if (readOnlyPatterns.some((pattern) => pattern.test(command))) {
    return 'read-only';
  }
  return 'safe-mutation';
}

function hasShellOperator(value: string) {
  return /(?:\n|&&|\|\||[;&|<>`]|\$\()/.test(value);
}

export { hardlineDescriptions };
