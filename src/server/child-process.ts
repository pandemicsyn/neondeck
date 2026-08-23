export type ManagedChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
};

export type ManagedChildController = {
  exit: Promise<ManagedChildExit>;
  stop: (signal?: NodeJS.Signals) => void;
  terminate: (signal?: NodeJS.Signals) => Promise<ManagedChildExit>;
};

type ControllableChild = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  once: {
    (event: 'error', listener: (error: Error) => void): unknown;
    (
      event: 'exit',
      listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ): unknown;
  };
};

type SignalSource = {
  on: (event: NodeJS.Signals, listener: () => void) => unknown;
  off: (event: NodeJS.Signals, listener: () => void) => unknown;
};

export function manageChildProcess(
  child: ControllableChild,
  options: {
    signalSource?: SignalSource;
    shutdownTimeoutMs?: number;
  } = {},
): ManagedChildController {
  const signalSource = options.signalSource ?? process;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  let settled = false;
  let termination: Promise<ManagedChildExit> | undefined;
  let resolveExit: (exit: ManagedChildExit) => void = () => undefined;
  const exit = new Promise<ManagedChildExit>((resolve) => {
    resolveExit = resolve;
  });

  const finish = (result: ManagedChildExit) => {
    if (settled) return;
    settled = true;
    signalSource.off('SIGINT', forwardSigint);
    signalSource.off('SIGTERM', forwardSigterm);
    resolveExit(result);
  };
  const stop = (signal: NodeJS.Signals = 'SIGTERM') => {
    if (settled || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        finish({
          code: null,
          signal: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  const terminate = (signal: NodeJS.Signals = 'SIGTERM') => {
    if (termination) {
      stop('SIGKILL');
      return termination;
    }
    termination = terminateWithEscalation(
      exit,
      stop,
      signal,
      shutdownTimeoutMs,
    );
    return termination;
  };
  const forwardSigint = () => {
    void terminate('SIGINT');
  };
  const forwardSigterm = () => {
    void terminate('SIGTERM');
  };

  signalSource.on('SIGINT', forwardSigint);
  signalSource.on('SIGTERM', forwardSigterm);
  child.once('error', (error) => {
    finish({
      code: null,
      signal: null,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  child.once('exit', (code, signal) => finish({ code, signal }));

  return { exit, stop, terminate };
}

async function terminateWithEscalation(
  exit: Promise<ManagedChildExit>,
  stop: (signal?: NodeJS.Signals) => void,
  signal: NodeJS.Signals,
  timeoutMs: number,
) {
  stop(signal);
  if (await waitForExit(exit, timeoutMs)) return exit;
  stop('SIGKILL');
  return exit;
}

async function waitForExit(exit: Promise<ManagedChildExit>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
