import { AsyncLocalStorage } from 'node:async_hooks';
import {
  instrument,
  type FlueExecutionContext,
  type FlueExecutionOperation,
} from '@flue/runtime';

const contextStorage = new AsyncLocalStorage<FlueExecutionContext>();
const instrumentationKey = Symbol.for('neondeck.flue.execution-context');
let installed = false;

export function installFlueExecutionContextTracker() {
  if (installed) return;
  instrument({
    key: instrumentationKey,
    observe() {
      return undefined;
    },
    async interceptor(operation, context, next) {
      if (operation.type !== 'tool') return next();
      return contextStorage.run(context, next);
    },
    dispose() {
      installed = false;
    },
  });
  installed = true;
}

export function currentFlueExecutionContext() {
  return contextStorage.getStore();
}

export function runWithFlueExecutionContextForTests<T>(
  context: FlueExecutionContext,
  callback: () => T,
) {
  return contextStorage.run(context, callback);
}

export type { FlueExecutionContext, FlueExecutionOperation };
