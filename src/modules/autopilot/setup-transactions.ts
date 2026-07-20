import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { writeJsonAtomic } from '../../runtime-home/files';
import { createLeaseOwnerRecord, leaseOwnerIsAlive } from './lease-owner';

type SetupTransaction = {
  watchId: string;
  state: 'pending' | 'failed';
  startedAt: string;
  updatedAt: string;
  message?: string;
};

type SetupTransactionFile = { version: 1; transactions: SetupTransaction[] };

function transactionPath(paths: RuntimePaths) {
  return join(paths.data, 'autopilot-setup-transactions.json');
}

function lockPath(paths: RuntimePaths) {
  return `${transactionPath(paths)}.lock`;
}

async function readTransactions(
  paths: RuntimePaths,
): Promise<SetupTransactionFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(transactionPath(paths), 'utf8'));
  } catch (error) {
    if (isNotFound(error)) return { version: 1, transactions: [] };
    throw new Error(
      `Autopilot setup recovery state is unreadable: ${message(error)}`,
    );
  }
  if (!isTransactionFile(parsed)) {
    throw new Error(
      'Autopilot setup recovery state is invalid and is fail-closed.',
    );
  }
  return parsed;
}

function isTransactionFile(value: unknown): value is SetupTransactionFile {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { transactions?: unknown }).transactions) &&
    (value as { transactions: unknown[] }).transactions.every(
      (transaction) =>
        transaction &&
        typeof transaction === 'object' &&
        typeof (transaction as { watchId?: unknown }).watchId === 'string' &&
        ['pending', 'failed'].includes(
          (transaction as { state?: unknown }).state as string,
        ) &&
        typeof (transaction as { startedAt?: unknown }).startedAt ===
          'string' &&
        typeof (transaction as { updatedAt?: unknown }).updatedAt ===
          'string' &&
        ((transaction as { message?: unknown }).message === undefined ||
          typeof (transaction as { message?: unknown }).message === 'string'),
    ),
  );
}

async function writeTransactions(
  paths: RuntimePaths,
  file: SetupTransactionFile,
) {
  await writeJsonAtomic(transactionPath(paths), file);
}

async function mutateTransactions<T>(
  paths: RuntimePaths,
  operation: (
    file: SetupTransactionFile,
  ) => Promise<{ file: SetupTransactionFile; value: T }>,
) {
  return withTransactionLock(paths, async () => {
    const { file, value } = await operation(await readTransactions(paths));
    await writeTransactions(paths, file);
    return value;
  });
}

export async function beginAutopilotSetupTransaction(
  watchId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  return mutateTransactions(paths, async (file) => {
    const now = new Date().toISOString();
    const previous = file.transactions.find(
      (transaction) => transaction.watchId === watchId,
    );
    const transaction: SetupTransaction = {
      watchId,
      state: 'pending',
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
    };
    return {
      file: {
        version: 1,
        transactions: [
          ...file.transactions.filter(
            (candidate) => candidate.watchId !== watchId,
          ),
          transaction,
        ],
      },
      value: transaction,
    };
  });
}

export async function failAutopilotSetupTransaction(
  watchId: string,
  failureMessage: string,
  paths: RuntimePaths = runtimePaths(),
) {
  return mutateTransactions(paths, async (file) => {
    const now = new Date().toISOString();
    const previous = file.transactions.find(
      (transaction) => transaction.watchId === watchId,
    );
    const transaction: SetupTransaction = {
      watchId,
      state: 'failed',
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
      message: failureMessage,
    };
    return {
      file: {
        version: 1,
        transactions: [
          ...file.transactions.filter(
            (candidate) => candidate.watchId !== watchId,
          ),
          transaction,
        ],
      },
      value: undefined,
    };
  });
}

export async function completeAutopilotSetupTransaction(
  watchId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  return mutateTransactions(paths, async (file) => ({
    file: {
      version: 1,
      transactions: file.transactions.filter(
        (transaction) => transaction.watchId !== watchId,
      ),
    },
    value: undefined,
  }));
}

export async function readAutopilotSetupTransaction(
  watchId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  return (await readTransactions(paths)).transactions.find(
    (transaction) => transaction.watchId === watchId,
  );
}

export async function isAutopilotSetupBlocked(
  watchId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  try {
    return Boolean(await readAutopilotSetupTransaction(watchId, paths));
  } catch {
    // A damaged durable marker must never turn a partially configured watch
    // back on. Setup itself will report the precise recovery-state failure.
    return true;
  }
}

/** Serialize the complete composite setup, not merely marker updates. */
export async function withAutopilotSetupWatchLease<T>(
  watchId: string,
  paths: RuntimePaths,
  operation: () => Promise<T>,
) {
  const path = join(
    paths.data,
    `autopilot-setup-${encodeURIComponent(watchId)}.lock`,
  );
  const ownerPath = join(path, 'owner');
  const token = randomUUID();
  const ownerRecord = await createLeaseOwnerRecord(token);
  await cleanupStaleLockGenerations(path);
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await mkdir(path);
      try {
        await writeFile(ownerPath, ownerRecord, 'utf8');
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!isExists(error)) throw error;
      const age = await lockAge(ownerPath, path);
      const observedToken = await readFile(ownerPath, 'utf8').catch(() => null);
      if (
        age > 300_000 &&
        !(await leaseOwnerIsAlive(observedToken)) &&
        (await stealStaleLock(path, observedToken))
      )
        continue;
      if (Date.now() >= deadline)
        throw new Error('Timed out waiting for the Autopilot setup lease.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await operation();
  } finally {
    const takeoverClaimed = await readFile(
      join(path, 'takeover'),
      'utf8',
    ).catch(() => null);
    if (
      (await readFile(ownerPath, 'utf8').catch(() => null)) === ownerRecord &&
      !(await hasFreshTakeoverClaim(path, takeoverClaimed))
    ) {
      await rm(path, { recursive: true, force: true });
    }
  }
}

async function withTransactionLock<T>(
  paths: RuntimePaths,
  operation: () => Promise<T>,
) {
  const path = lockPath(paths);
  const ownerPath = join(path, 'owner');
  const token = randomUUID();
  const ownerRecord = await createLeaseOwnerRecord(token);
  await cleanupStaleLockGenerations(path);
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await mkdir(path);
      try {
        await writeFile(ownerPath, ownerRecord, 'utf8');
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!isExists(error)) throw error;
      const age = await lockAge(ownerPath, path);
      const observedToken = await readFile(ownerPath, 'utf8').catch(() => null);
      if (
        age > 300_000 &&
        !(await leaseOwnerIsAlive(observedToken)) &&
        (await stealStaleLock(path, observedToken))
      )
        continue;
      if (Date.now() >= deadline) {
        throw new Error(
          'Timed out waiting for the Autopilot setup recovery lock.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await operation();
  } finally {
    const takeoverClaimed = await readFile(
      join(path, 'takeover'),
      'utf8',
    ).catch(() => null);
    if (
      (await readFile(ownerPath, 'utf8').catch(() => null)) === ownerRecord &&
      !(await hasFreshTakeoverClaim(path, takeoverClaimed))
    ) {
      await rm(path, { recursive: true, force: true });
    }
  }
}

async function lockAge(ownerPath: string, path: string) {
  return stat(ownerPath)
    .then((value) => Date.now() - value.mtimeMs)
    .catch(() =>
      stat(path)
        .then((value) => Date.now() - value.mtimeMs)
        .catch(() => 0),
    );
}

/** Reap interrupted takeover directories after their recovery grace period. */
async function cleanupStaleLockGenerations(path: string) {
  const parent = dirname(path);
  const prefix = `${basename(path)}.stale-`;
  const entries = await readdir(parent).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map(async (entry) => {
        const candidate = join(parent, entry);
        const age = await stat(candidate)
          .then((value) => Date.now() - value.mtimeMs)
          .catch(() => 0);
        if (age > 300_000)
          await rm(candidate, { recursive: true, force: true });
      }),
  );
}

async function stealStaleLock(path: string, observedToken: string | null) {
  const takeoverPath = join(path, 'takeover');
  const takeoverToken = randomUUID();
  try {
    await writeFile(takeoverPath, takeoverToken, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (isExists(error)) {
      if (!(await hasFreshTakeoverClaim(path))) {
        await rm(takeoverPath, { force: true });
      }
      return false;
    }
    if (isNotFound(error)) return false;
    throw error;
  }
  const currentToken = await readFile(join(path, 'owner'), 'utf8').catch(
    () => null,
  );
  if (currentToken !== observedToken) {
    if (
      (await readFile(takeoverPath, 'utf8').catch(() => null)) === takeoverToken
    ) {
      await rm(takeoverPath, { force: true });
    }
    return false;
  }
  const stalePath = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, stalePath);
  } catch (error) {
    if (isExists(error) || isNotFound(error)) return false;
    throw error;
  }
  await rm(stalePath, { recursive: true, force: true });
  return true;
}

async function hasFreshTakeoverClaim(path: string, claim?: string | null) {
  if (!claim) return false;
  const age = await stat(join(path, 'takeover'))
    .then((value) => Date.now() - value.mtimeMs)
    .catch(() => Infinity);
  return age <= 300_000;
}

function isExists(error: unknown) {
  return errorCode(error) === 'EEXIST';
}

function isNotFound(error: unknown) {
  return errorCode(error) === 'ENOENT';
}

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
