import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { readNeonSessionState } from './active-session';
import {
  createChatSession,
  switchChatSession,
  renameChatSession,
  pinChatSession,
  archiveChatSession,
  restoreChatSession,
  linkChatSessionContext,
} from './service';
import {
  listChatSessions,
  searchChatSessions,
  readChatSession,
  readChatSessionMessages,
} from './queries';
import { refreshChatSessionSummary } from './summaries';
import { referenceChatSession } from './references';
import {
  sessionActionOutputSchema,
  sessionArchiveInputSchema,
  sessionCreateInputSchema,
  sessionLinkContextInputSchema,
  sessionListInputSchema,
  sessionMessagesInputSchema,
  sessionPinInputSchema,
  sessionReadInputSchema,
  sessionReferenceInputSchema,
  sessionRefreshSummaryInputSchema,
  sessionRenameInputSchema,
  sessionSearchInputSchema,
  sessionSwitchInputSchema,
  surfaceSchema,
} from './schemas';

export const sessionListAction = defineTool({
  name: 'neondeck_session_list',
  description:
    'List Neondeck chat session metadata. Transcripts remain in Flue persistence.',
  input: sessionListInputSchema,
  output: v.looseObject({ ok: v.boolean() }),
  async run({ data: input }) {
    return { output: await listChatSessions(input) };
  },
});

export const sessionSearchAction = defineTool({
  name: 'neondeck_session_search',
  description:
    'Search Neondeck chat session metadata and summaries without reading raw transcripts.',
  input: sessionSearchInputSchema,
  output: v.looseObject({ ok: v.boolean() }),
  async run({ data: input }) {
    return { output: await searchChatSessions(input) };
  },
});

export const sessionReadAction = defineTool({
  name: 'neondeck_session_read',
  description:
    'Read one Neondeck chat session metadata record and audit the read.',
  input: sessionReadInputSchema,
  output: sessionActionOutputSchema,
  async run({ data: input }) {
    return { output: await readChatSession(input) };
  },
});

export const sessionMessagesAction = defineTool({
  name: 'neondeck_session_messages',
  description:
    'Audit an explicit user-requested Flue transcript read. Neondeck does not duplicate transcripts in app state.',
  input: sessionMessagesInputSchema,
  output: sessionActionOutputSchema,
  async run({ data: input }) {
    return { output: await readChatSessionMessages(input) };
  },
});

export const sessionRefreshSummaryAction = defineTool({
  name: 'neondeck_session_refresh_summary',
  description:
    'Refresh a stored chat-session summary from bounded metadata, or store an explicitly provided summary.',
  input: sessionRefreshSummaryInputSchema,
  output: sessionActionOutputSchema,
  async run({ data: input }) {
    return { output: await refreshChatSessionSummary(input) };
  },
});

export const sessionReferenceAction = defineTool({
  name: 'neondeck_session_reference',
  description:
    'Read a compact cross-session reference payload from summary and metadata, auditing the context use.',
  input: sessionReferenceInputSchema,
  output: sessionActionOutputSchema,
  async run({ data: input }) {
    return { output: await referenceChatSession(input) };
  },
});

export const sessionCreateAction = defineTool({
  name: 'neondeck_session_create',
  description:
    'Create a durable chat session metadata record for display-assistant and optionally switch a surface to it.',
  input: sessionCreateInputSchema,
  output: sessionActionOutputSchema,
  async run({ data: input }) {
    return { output: await createChatSession(input) };
  },
});

export const sessionSwitchAction = defineTool({
  name: 'neondeck_session_switch',
  description:
    'Switch a dashboard/TUI surface to an existing non-archived display-assistant session.',
  input: sessionSwitchInputSchema,
  output: sessionActionOutputSchema,
  async run({ data: input }) {
    return { output: await switchChatSession(input) };
  },
});

export const sessionRenameAction = defineTool({
  name: 'neondeck_session_rename',
  description: 'Rename a Neondeck chat session metadata record.',
  input: sessionRenameInputSchema,
  output: sessionActionOutputSchema,
  async run({ data: input }) {
    return { output: await renameChatSession(input) };
  },
});

export const sessionPinAction = defineTool({
  name: 'neondeck_session_pin',
  description: 'Pin or unpin a Neondeck chat session.',
  input: sessionPinInputSchema,
  output: sessionActionOutputSchema,
  async run({ data: input }) {
    return { output: await pinChatSession(input) };
  },
});

export const sessionArchiveAction = defineTool({
  name: 'neondeck_session_archive',
  description:
    'Archive a chat session metadata record. This does not delete Flue conversation history.',
  input: sessionArchiveInputSchema,
  output: sessionActionOutputSchema,
  async run({ data: input }) {
    return { output: await archiveChatSession(input) };
  },
});

export const sessionRestoreAction = defineTool({
  name: 'neondeck_session_restore',
  description: 'Restore an archived chat session metadata record.',
  input: sessionArchiveInputSchema,
  output: sessionActionOutputSchema,
  async run({ data: input }) {
    return { output: await restoreChatSession(input) };
  },
});

export const sessionLinkContextAction = defineTool({
  name: 'neondeck_session_link_context',
  description:
    'Attach repo, watch, task, UI metadata, or a summary to a chat session metadata record.',
  input: sessionLinkContextInputSchema,
  output: sessionActionOutputSchema,
  async run({ data: input }) {
    return { output: await linkChatSessionContext(input) };
  },
});

export const sessionStatusAction = defineTool({
  name: 'neondeck_session_status',
  description:
    'Read the active Neon display-assistant session id and whether config or memory changes make its context stale.',
  input: v.object({ surface: v.optional(surfaceSchema) }),
  output: sessionActionOutputSchema,
  async run({ data: input }) {
    const state = await readNeonSessionState(undefined, input.surface);
    return {
      output: {
        ok: true,
        action: 'session_status',
        changed: false,
        message: state.stale
          ? 'Active Neon session context is stale. Start or switch to a fresh session to reload config, skills, and memory context.'
          : 'Active Neon session context is current.',
        state,
      },
    };
  },
});

export const neondeckSessionActions = [
  sessionListAction,
  sessionSearchAction,
  sessionReadAction,
  sessionMessagesAction,
  sessionRefreshSummaryAction,
  sessionReferenceAction,
  sessionCreateAction,
  sessionSwitchAction,
  sessionRenameAction,
  sessionPinAction,
  sessionArchiveAction,
  sessionRestoreAction,
  sessionLinkContextAction,
  sessionStatusAction,
];
