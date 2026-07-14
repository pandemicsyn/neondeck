import { currentFlueExecutionContext } from './execution-context';

export type TaskOrigin = 'interactive' | 'autopilot';

export function currentTaskOrigin(): TaskOrigin {
  return currentFlueExecutionContext()?.runId ? 'autopilot' : 'interactive';
}
