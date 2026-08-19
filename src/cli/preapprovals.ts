export type PreapprovalGroupId =
  | 'filesystem'
  | 'process'
  | 'git-read'
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'python'
  | 'go';

type PreapprovalCommand = {
  id: string;
  command: string;
  match: 'exact' | 'prefix' | 'glob';
  description: string;
};

export const preapprovalGroups: Array<{
  id: PreapprovalGroupId;
  label: string;
  hint: string;
  commands: PreapprovalCommand[];
}> = [
  {
    id: 'filesystem',
    label: 'Filesystem inspection',
    hint: 'pwd, ls, find, cat, sed, rg, wc, head, tail, stat, file, du, jq.',
    commands: [
      commandPreapproval('pwd', 'pwd', 'exact', 'Print the current directory.'),
      commandPreapproval(
        'ls',
        'ls',
        'prefix',
        'List local files and directories.',
      ),
      commandPreapproval(
        'find',
        'find',
        'prefix',
        'Find local files and directories.',
      ),
      commandPreapproval('cat', 'cat', 'prefix', 'Read local text files.'),
      commandPreapproval('sed', 'sed', 'prefix', 'Read local text ranges.'),
      commandPreapproval('rg', 'rg', 'prefix', 'Search local text files.'),
      commandPreapproval(
        'wc',
        'wc',
        'prefix',
        'Count local text file lines or bytes.',
      ),
      commandPreapproval('head', 'head', 'prefix', 'Read the start of files.'),
      commandPreapproval('tail', 'tail', 'prefix', 'Read the end of files.'),
      commandPreapproval(
        'stat',
        'stat',
        'prefix',
        'Inspect local file metadata.',
      ),
      commandPreapproval('file', 'file', 'prefix', 'Inspect local file types.'),
      commandPreapproval(
        'du',
        'du',
        'prefix',
        'Inspect local file and directory sizes.',
      ),
      commandPreapproval('jq', 'jq', 'prefix', 'Inspect and transform JSON.'),
    ],
  },
  {
    id: 'process',
    label: 'Process inspection',
    hint: 'ps, lsof.',
    commands: [
      commandPreapproval('ps', 'ps', 'prefix', 'Inspect local processes.'),
      commandPreapproval(
        'lsof',
        'lsof',
        'prefix',
        'Inspect open local files and network sockets.',
      ),
    ],
  },
  {
    id: 'git-read',
    label: 'Git inspection',
    hint: 'status, diff, show, log, branch, rev-parse.',
    commands: [
      commandPreapproval(
        'git-status',
        'git status',
        'prefix',
        'Inspect git working tree status.',
      ),
      commandPreapproval(
        'git-diff',
        'git diff',
        'prefix',
        'Inspect unstaged or staged git diffs.',
      ),
      commandPreapproval(
        'git-show',
        'git show',
        'prefix',
        'Inspect git objects and commits.',
      ),
      commandPreapproval(
        'git-log',
        'git log',
        'prefix',
        'Inspect git commit history.',
      ),
      commandPreapproval(
        'git-branch',
        'git branch',
        'prefix',
        'Inspect git branches.',
      ),
      commandPreapproval(
        'git-rev-parse',
        'git rev-parse',
        'prefix',
        'Inspect git revision and repository metadata.',
      ),
    ],
  },
  {
    id: 'npm',
    label: 'npm',
    hint: 'npm run, test, install, exec, view, list.',
    commands: [
      commandPreapproval('npm-run', 'npm run', 'prefix', 'Run npm scripts.'),
      commandPreapproval('npm-test', 'npm test', 'prefix', 'Run npm tests.'),
      commandPreapproval(
        'npm-install',
        'npm install',
        'prefix',
        'Install npm dependencies.',
      ),
      commandPreapproval('npm-exec', 'npm exec', 'prefix', 'Run npm binaries.'),
      commandPreapproval(
        'npm-view',
        'npm view',
        'prefix',
        'Read npm package metadata.',
      ),
      commandPreapproval(
        'npm-list',
        'npm list',
        'prefix',
        'List installed npm dependencies.',
      ),
    ],
  },
  {
    id: 'pnpm',
    label: 'pnpm',
    hint: 'pnpm run, test, install, exec, view, list.',
    commands: [
      commandPreapproval('pnpm-run', 'pnpm run', 'prefix', 'Run pnpm scripts.'),
      commandPreapproval('pnpm-test', 'pnpm test', 'prefix', 'Run pnpm tests.'),
      commandPreapproval(
        'pnpm-install',
        'pnpm install',
        'prefix',
        'Install pnpm dependencies.',
      ),
      commandPreapproval(
        'pnpm-exec',
        'pnpm exec',
        'prefix',
        'Run pnpm binaries.',
      ),
      commandPreapproval(
        'pnpm-view',
        'pnpm view',
        'prefix',
        'Read pnpm package metadata.',
      ),
      commandPreapproval(
        'pnpm-list',
        'pnpm list',
        'prefix',
        'List installed pnpm dependencies.',
      ),
    ],
  },
  {
    id: 'yarn',
    label: 'Yarn',
    hint: 'yarn run, test, install, exec, info, list.',
    commands: [
      commandPreapproval('yarn-run', 'yarn run', 'prefix', 'Run Yarn scripts.'),
      commandPreapproval('yarn-test', 'yarn test', 'prefix', 'Run Yarn tests.'),
      commandPreapproval(
        'yarn-install',
        'yarn install',
        'prefix',
        'Install Yarn dependencies.',
      ),
      commandPreapproval(
        'yarn-exec',
        'yarn exec',
        'prefix',
        'Run Yarn binaries.',
      ),
      commandPreapproval(
        'yarn-info',
        'yarn info',
        'prefix',
        'Read Yarn package metadata.',
      ),
      commandPreapproval(
        'yarn-list',
        'yarn list',
        'prefix',
        'List installed Yarn dependencies.',
      ),
    ],
  },
  {
    id: 'bun',
    label: 'Bun',
    hint: 'bun run, test, install, x.',
    commands: [
      commandPreapproval('bun-run', 'bun run', 'prefix', 'Run Bun scripts.'),
      commandPreapproval('bun-test', 'bun test', 'prefix', 'Run Bun tests.'),
      commandPreapproval(
        'bun-install',
        'bun install',
        'prefix',
        'Install Bun dependencies.',
      ),
      commandPreapproval('bun-x', 'bun x', 'prefix', 'Run Bun binaries.'),
    ],
  },
  {
    id: 'python',
    label: 'Python and uv',
    hint: 'python, python3, pip, uv.',
    commands: [
      commandPreapproval('python', 'python', 'prefix', 'Run Python commands.'),
      commandPreapproval(
        'python3',
        'python3',
        'prefix',
        'Run Python 3 commands.',
      ),
      commandPreapproval('pip', 'pip', 'prefix', 'Run pip commands.'),
      commandPreapproval('pip3', 'pip3', 'prefix', 'Run pip3 commands.'),
      commandPreapproval('uv', 'uv', 'prefix', 'Run uv commands.'),
    ],
  },
  {
    id: 'go',
    label: 'Go',
    hint: 'go test, run, build, list, mod.',
    commands: [
      commandPreapproval('go-test', 'go test', 'prefix', 'Run Go tests.'),
      commandPreapproval('go-run', 'go run', 'prefix', 'Run Go programs.'),
      commandPreapproval('go-build', 'go build', 'prefix', 'Build Go code.'),
      commandPreapproval('go-list', 'go list', 'prefix', 'List Go packages.'),
      commandPreapproval('go-mod', 'go mod', 'prefix', 'Manage Go modules.'),
    ],
  },
];

export function commandPreapproval(
  id: string,
  command: string,
  match: PreapprovalCommand['match'],
  description: string,
): PreapprovalCommand {
  return { id, command, match, description };
}
