import {
  createExeVm,
  createSshSessionEnv,
  deleteExeVm,
} from '../src/sandboxes/exedev.ts';

const apiToken = process.env.EXE_API_TOKEN;
if (!apiToken || process.env.NEONDECK_EXEDEV_SMOKE !== '1') {
  console.error(
    'Set EXE_API_TOKEN and NEONDECK_EXEDEV_SMOKE=1 to run the opt-in exe.dev lifecycle smoke test.',
  );
  process.exitCode = 2;
} else {
  let vm;
  try {
    vm = await createExeVm({
      apiToken,
      ssh: { privateKeyPath: process.env.EXE_SSH_KEY },
    });
    const connection = await createSshSessionEnv(vm, {
      privateKeyPath: process.env.EXE_SSH_KEY,
    });
    try {
      const result = await connection.env.exec(
        'mkdir -p neondeck-workspace-smoke && git --version && test -d neondeck-workspace-smoke',
        { cwd: connection.env.cwd, timeoutMs: 30_000 },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr || `Smoke command exited ${result.exitCode}`,
        );
      }
      console.log(`exe.dev workspace smoke passed on ${vm.name}.`);
    } finally {
      connection.dispose();
    }
  } finally {
    if (vm?.name) await deleteExeVm({ apiToken, name: vm.name });
  }
}
