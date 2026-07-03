import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { readNeonSessionState } from './active-session';
import {
  createChatSession,
  startNeonSession,
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
  legacySessionStartInputSchema,
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

export const sessionListAction = defineAction({
  name: 'neondeck_session_list',
  description:
    'List Neondeck chat session metadata. Transcripts remain in Flue persistence.',
  input: sessionListInputSchema,
  output: v.looseObject({ ok: v.boolean() }),
  async run({ input }) {
    return listChatSessions(input);
  },
});

export const sessionSearchAction = defineAction({
  name: 'neondeck_session_search',
  description:
    'Search Neondeck chat session metadata and summaries without reading raw transcripts.',
  input: sessionSearchInputSchema,
  output: v.looseObject({ ok: v.boolean() }),
  async run({ input }) {
    return searchChatSessions(input);
  },
});

export const sessionReadAction = defineAction({
  name: 'neondeck_session_read',
  description:
    'Read one Neondeck chat session metadata record and audit the read.',
  input: sessionReadInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return readChatSession(input);
  },
});

export const sessionMessagesAction = defineAction({
  name: 'neondeck_session_messages',
  description:
    'Audit an explicit user-requested Flue transcript read. Neondeck does not duplicate transcripts in app state.',
  input: sessionMessagesInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return readChatSessionMessages(input);
  },
});

export const sessionRefreshSummaryAction = defineAction({
  name: 'neondeck_session_refresh_summary',
  description:
    'Refresh a stored chat-session summary from bounded metadata, or store an explicitly provided summary.',
  input: sessionRefreshSummaryInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return refreshChatSessionSummary(input);
  },
});

export const sessionReferenceAction = defineAction({
  name: 'neondeck_session_reference',
  description:
    'Read a compact cross-session reference payload from summary and metadata, auditing the context use.',
  input: sessionReferenceInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return referenceChatSession(input);
  },
});

export const sessionCreateAction = defineAction({
  name: 'neondeck_session_create',
  description:
    'Create a durable chat session metadata record for display-assistant and optionally switch a surface to it.',
  input: sessionCreateInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return createChatSession(input);
  },
});

export const sessionSwitchAction = defineAction({
  name: 'neondeck_session_switch',
  description:
    'Switch a dashboard/TUI surface to an existing non-archived display-assistant session.',
  input: sessionSwitchInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return switchChatSession(input);
  },
});

export const sessionRenameAction = defineAction({
  name: 'neondeck_session_rename',
  description: 'Rename a Neondeck chat session metadata record.',
  input: sessionRenameInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return renameChatSession(input);
  },
});

export const sessionPinAction = defineAction({
  name: 'neondeck_session_pin',
  description: 'Pin or unpin a Neondeck chat session.',
  input: sessionPinInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return pinChatSession(input);
  },
});

export const sessionArchiveAction = defineAction({
  name: 'neondeck_session_archive',
  description:
    'Archive a chat session metadata record. This does not delete Flue conversation history.',
  input: sessionArchiveInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return archiveChatSession(input);
  },
});

export const sessionRestoreAction = defineAction({
  name: 'neondeck_session_restore',
  description: 'Restore an archived chat session metadata record.',
  input: sessionArchiveInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return restoreChatSession(input);
  },
});

export const sessionLinkContextAction = defineAction({
  name: 'neondeck_session_link_context',
  description:
    'Attach repo, watch, task, UI metadata, or a summary to a chat session metadata record.',
  input: sessionLinkContextInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return linkChatSessionContext(input);
  },
});

export const sessionStatusAction = defineAction({
  name: 'neondeck_session_status',
  description:
    'Read the active Neon display-assistant session id and whether config or memory changes make its context stale.',
  input: v.object({ surface: v.optional(surfaceSchema) }),
  output: sessionActionOutputSchema,
  async run({ input }) {
    const state = await readNeonSessionState(undefined, input.surface);
    return {
      ok: true,
      action: 'session_status',
      changed: false,
      message: state.stale
        ? 'Active Neon session context is stale. Start or switch to a fresh session to reload config, skills, and memory context.'
        : 'Active Neon session context is current.',
      state,
    };
  },
});

export const sessionStartAction = defineAction({
  name: 'neondeck_session_start',
  description:
    'Compatibility action for starting and activating a new Neon display-assistant session.',
  input: legacySessionStartInputSchema,
  output: sessionActionOutputSchema,
  async run({ input }) {
    return startNeonSession(input);
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
  sessionStartAction,
];
