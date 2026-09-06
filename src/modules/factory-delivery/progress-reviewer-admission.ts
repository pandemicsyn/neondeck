import { AsyncLocalStorage } from 'node:async_hooks';
import {
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { instrument, type FlueExecutionOperation } from '@flue/runtime';
import * as v from 'valibot';
import { runtimePaths } from '../../runtime-home/paths';
import { progressDigest } from './progress-evidence-contract';
const identitySchema = v.strictObject({
  instanceId: v.pipe(v.string(), v.minLength(1)),
  submissionId: v.pipe(v.string(), v.minLength(1)),
});
const streamingOperations = new WeakSet<FlueExecutionOperation>();
const scope = new AsyncLocalStorage<v.InferOutput<typeof identitySchema>>();
/** A durable create-only claim precedes the provider call. An interrupted or
 * failed call still consumes the slot. No read, abort, or restart removes it. */
export function claimProgressModelResponse(
  identity: unknown,
  home = runtimePaths().home,
) {
  const value = v.parse(identitySchema, identity);
  const directory = join(home, 'factory-progress-model-admissions');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${progressDigest(value.instanceId)}.json`);
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch {
    throw new Error(
      'Progress provider allowance consumed or durable admission unavailable',
    );
  }
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(directory, 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
// Flue 2.0.3 reference/events: model interception wraps each provider request;
// throwing prevents next(). Async context carries submission identity into
// model operations whose own correlation fields may omit agentName. The installed
// implementation also intercepts each stream iterator call with the SAME operation
// object. Only that live object may continue streaming; a new object or a restart
// must claim again and is denied. This WeakSet never grants durable admission.
instrument({
  key: Symbol.for('neondeck.factory-progress.one-model-response'),
  observe: () => {},
  dispose: () => {},
  async interceptor(operation, context, next) {
    if (
      operation.type === 'agent' &&
      context.agentName === 'factory-progress-reviewer' &&
      context.instanceId &&
      context.submissionId
    ) {
      return scope.run(
        v.parse(identitySchema, {
          instanceId: context.instanceId,
          submissionId: context.submissionId,
        }),
        next,
      );
    }
    if (operation.type === 'model') {
      const identity = scope.getStore();
      if (identity) {
        if (!streamingOperations.has(operation)) {
          claimProgressModelResponse(identity);
          streamingOperations.add(operation);
        }
      } else if (context.agentName === 'factory-progress-reviewer')
        throw new Error('Progress model admission identity unavailable');
    }
    return next();
  },
});
