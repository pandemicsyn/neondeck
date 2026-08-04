import { AsyncLocalStorage } from 'node:async_hooks';
import {
  instrument,
  type FlueExecutionContext,
  type FlueExecutionOperation,
} from '@flue/runtime';

const contextStorage = new AsyncLocalStorage<FlueExecutionContext>();
const boundedReviewPromptStorage = new AsyncLocalStorage<'blocked'>();
const instrumentationKey = Symbol.for('neondeck.flue.execution-context');
let installed = false;

export async function neondeckFlueExecutionInterceptor<T>(
  operation: FlueExecutionOperation,
  context: FlueExecutionContext,
  next: () => Promise<T>,
) {
  if (
    boundedReviewPromptStorage.getStore() === 'blocked' &&
    ((operation.type === 'tool' && operation.toolName === 'task') ||
      operation.type === 'task' ||
      (operation.type === 'tool' &&
        operation.toolName === 'neondeck_pr_review_for_human'))
  ) {
    throw new Error(
      'Task delegation and recursive PR review orchestration are disabled inside the bounded review prompt. Inspect the supplied workspace directly and finish the structured review in the current session.',
    );
  }
  return contextStorage.run({ ...contextStorage.getStore(), ...context }, next);
}

export function installFlueExecutionContextTracker() {
  if (installed) return;
  instrument({
    key: instrumentationKey,
    observe() {
      return undefined;
    },
    interceptor: neondeckFlueExecutionInterceptor,
    dispose() {
      installed = false;
    },
  });
  installed = true;
}

export function currentFlueExecutionContext() {
  return contextStorage.getStore();
}

export function runWithFlueTaskDelegationBlocked<T>(callback: () => T) {
  return boundedReviewPromptStorage.run('blocked', callback);
}

export function runWithFlueExecutionContextForTests<T>(
  context: FlueExecutionContext,
  callback: () => T,
) {
  return contextStorage.run(context, callback);
}

export type { FlueExecutionContext, FlueExecutionOperation };
