// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  readWorkflowDraft,
  writeWorkflowDraft,
  clearWorkflowDraft,
  type WorkflowDraft,
} from './workflow-draft';
const draft = (): WorkflowDraft => ({
  version: 1,
  base: { repoId: 'repo', fingerprint: 'a'.repeat(64), workflows: null },
  draft: {
    defaultProfileId: '',
    profiles: [
      {
        id: '',
        name: '',
        setupCommands: [{ command: '', cwd: '' }],
        validationCommands: [],
        setupTimeoutMs: 0,
        validationTimeoutMs: 1,
        runtime: { node: '>=' },
        environmentRefs: ['TOKEN_'],
      },
    ],
  },
  profileIndex: 7,
  proposal: null,
});
beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());
it('validates incomplete edits and binds stored data to its repository', () => {
  expect(writeWorkflowDraft('repo', draft())).toBe(true);
  expect(readWorkflowDraft('repo')).toEqual({
    status: 'loaded',
    value: draft(),
  });
  expect(writeWorkflowDraft('other', draft())).toBe(false);
  expect(readWorkflowDraft('other')).toEqual({ status: 'missing' });
});
it.each([
  '{',
  '{"version":2}',
  JSON.stringify({ ...draft(), version: 2 }),
  JSON.stringify({ ...draft(), base: { ...draft().base, repoId: 'other' } }),
])(
  'rejects corrupt, mismatched and unsupported versions without returning raw input',
  (raw) => {
    sessionStorage.setItem('factory-workflow-draft:repo', raw);
    expect(readWorkflowDraft('repo')).toEqual({ status: 'failed' });
    expect(sessionStorage.getItem('factory-workflow-draft:repo')).toBe(raw);
  },
);
it('handles unavailable reads, writes and explicit clear without throwing or exposing errors', () => {
  vi.spyOn(Object.getPrototypeOf(sessionStorage), 'getItem').mockImplementation(
    () => {
      throw new Error('private details');
    },
  );
  vi.spyOn(Object.getPrototypeOf(sessionStorage), 'setItem').mockImplementation(
    () => {
      throw new Error('private details');
    },
  );
  vi.spyOn(
    Object.getPrototypeOf(sessionStorage),
    'removeItem',
  ).mockImplementation(() => {
    throw new Error('private details');
  });
  expect(readWorkflowDraft('repo')).toEqual({ status: 'failed' });
  expect(writeWorkflowDraft('repo', draft())).toBe(false);
  expect(clearWorkflowDraft('repo')).toBe(false);
});
