import { defineAction, defineTool } from '@flue/runtime';
import {
  eventsInputSchema,
  outputSchema,
  reconcileInputSchema,
  sessionReadInputSchema,
  sessionsSearchInputSchema,
  startInputSchema,
  taskIdInputSchema,
  taskStatusOutputSchema,
  tasksListInputSchema,
  tasksListOutputSchema,
} from './schemas';
import {
  abortKiloTask,
  listKiloTasks,
  readKiloTaskDiff,
  readKiloTaskEvents,
  readKiloTaskSessions,
  readKiloTaskStatus,
  reconcileKiloTask,
  startKiloTask,
} from './service';
import {
  readKiloSession,
  readKiloSessionChildren,
  readKiloSessionDiff,
  readKiloSessionMessages,
  readUnavailableSessionAdapter,
  searchKiloSessions,
} from './sessions';

export type {
  KiloChildSessionNode,
  KiloResultPlaceholder,
  KiloSessionReadOptions,
} from './schemas';
export type {
  KiloHandoffMode,
  KiloTaskEventRecord,
  KiloTaskRecord,
  KiloTaskStatus,
} from './store';
export {
  startKiloTask,
  listKiloTasks,
  readKiloTaskStatus,
  readKiloTaskEvents,
  abortKiloTask,
  readKiloTaskSessions,
  readKiloTaskDiff,
  reconcileKiloTask,
} from './service';
export { summarizeKiloSession } from './service';
export {
  searchKiloSessions,
  readKiloSession,
  readKiloSessionMessages,
  readKiloSessionChildren,
  readUnavailableSessionAdapter,
  readKiloSessionDiff,
} from './sessions';

export const kiloTaskStartAction = defineAction({
  name: 'neondeck_kilo_task_start',
  description:
    'Explicitly start a background KiloCode handoff in a declared repo or Neondeck-managed worktree and persist task/event state.',
  input: startInputSchema,
  output: outputSchema,
  async run({ input }) {
    return startKiloTask(input);
  },
});

export const kiloTaskStatusAction = defineAction({
  name: 'neondeck_kilo_task_status',
  description: 'Read one persisted Kilo handoff task status.',
  input: taskIdInputSchema,
  output: taskStatusOutputSchema,
  async run({ input }) {
    return readKiloTaskStatus(input);
  },
});

export const kiloTaskEventsAction = defineAction({
  name: 'neondeck_kilo_task_events',
  description: 'Read persisted Kilo handoff task events.',
  input: eventsInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readKiloTaskEvents(input);
  },
});

export const kiloTaskAbortAction = defineAction({
  name: 'neondeck_kilo_task_abort',
  description: 'Cancel a running Kilo handoff task and mark it cancelled.',
  input: taskIdInputSchema,
  output: outputSchema,
  async run({ input }) {
    return abortKiloTask(input);
  },
});

export const kiloTaskSessionsAction = defineAction({
  name: 'neondeck_kilo_task_sessions',
  description: 'List root and child Kilo session ids linked to one task.',
  input: taskIdInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readKiloTaskSessions(input);
  },
});

export const kiloTaskDiffAction = defineAction({
  name: 'neondeck_kilo_task_diff',
  description: 'Read a git diff summary for the workspace used by a Kilo task.',
  input: taskIdInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readKiloTaskDiff(input);
  },
});

export const kiloTaskReconcileAction = defineAction({
  name: 'neondeck_kilo_task_reconcile',
  description:
    'Reconcile persisted Kilo task state after restart by inspecting detached task process/session/diff state.',
  input: reconcileInputSchema,
  output: outputSchema,
  async run({ input }) {
    return reconcileKiloTask(input);
  },
});

export const kiloSessionsSearchAction = defineAction({
  name: 'neondeck_kilo_sessions_search',
  description:
    'Search Kilo session metadata through linked Neondeck tasks and the Kilo CLI session list fallback.',
  input: sessionsSearchInputSchema,
  output: outputSchema,
  async run({ input }) {
    return searchKiloSessions(input);
  },
});

export const kiloSessionReadAction = defineAction({
  name: 'neondeck_kilo_session_read',
  description:
    'Read normalized Kilo session metadata linked to a task or found through Kilo CLI session list. Transcript paging is deferred.',
  input: sessionReadInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readKiloSession(input);
  },
});

export const kiloSessionMessagesAction = defineAction({
  name: 'neondeck_kilo_session_messages',
  description:
    'Audit a request for Kilo session messages. The CLI MVP returns metadata only until a stable transcript adapter is wired.',
  input: sessionReadInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readKiloSessionMessages(input);
  },
});

export const kiloSessionChildrenAction = defineAction({
  name: 'neondeck_kilo_session_children',
  description:
    'Read child Kilo session ids captured from persisted task events.',
  input: sessionReadInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readKiloSessionChildren(input);
  },
});

export const kiloSessionTodosAction = defineAction({
  name: 'neondeck_kilo_session_todos',
  description:
    'Report that Kilo todo access is unavailable in the CLI MVP while returning linked session metadata.',
  input: sessionReadInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readUnavailableSessionAdapter(input, 'todos');
  },
});

export const kiloSessionDiffAction = defineAction({
  name: 'neondeck_kilo_session_diff',
  description:
    'Read the Neondeck task workspace diff summary for a linked Kilo session when available.',
  input: sessionReadInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readKiloSessionDiff(input);
  },
});

export const kiloTasksLookupTool = defineTool({
  name: 'neondeck_kilo_tasks_lookup',
  description:
    'List persisted Kilo handoff tasks without starting or cancelling work.',
  input: tasksListInputSchema,
  output: tasksListOutputSchema,
  async run({ input }) {
    return listKiloTasks(input);
  },
});

export const neondeckKiloActions = [
  kiloTaskStartAction,
  kiloTaskStatusAction,
  kiloTaskEventsAction,
  kiloTaskAbortAction,
  kiloTaskSessionsAction,
  kiloTaskDiffAction,
  kiloTaskReconcileAction,
  kiloSessionsSearchAction,
  kiloSessionReadAction,
  kiloSessionMessagesAction,
  kiloSessionChildrenAction,
  kiloSessionTodosAction,
  kiloSessionDiffAction,
];

export const neondeckKiloTools = [kiloTasksLookupTool];
