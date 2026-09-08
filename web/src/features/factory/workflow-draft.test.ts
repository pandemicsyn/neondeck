// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { saveRepoWorkflowsInputSchema } from '../../../../shared/repo-workflows';
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
it('restores reserved references in the base, proposal and draft for repair while save admission remains strict', () => {
  const workflows = {
    defaultProfileId: 'web',
    profiles: [
      {
        ...draft().draft!.profiles[0],
        id: 'web',
        name: 'Web',
        setupCommands: [],
        setupTimeoutMs: 1000,
        validationTimeoutMs: 1000,
        runtime: {},
        environmentRefs: ['NODE_OPTIONS'],
      },
    ],
  };
  const stored: WorkflowDraft = {
    ...draft(),
    base: { ...draft().base, workflows },
    draft: workflows,
    profileIndex: 0,
    proposal: {
      workflows,
      rationale: 'Stored suggestion requiring repair',
      evidencePaths: ['package.json'],
      evidenceRevision: 'a'.repeat(40),
    },
  };
  expect(writeWorkflowDraft('repo', stored)).toBe(true);
  const restored = readWorkflowDraft('repo');
  expect(restored).toEqual({ status: 'loaded', value: stored });
  if (restored.status !== 'loaded') throw new Error('Draft did not restore');
  const input = {
    expectedFingerprint: restored.value.base.fingerprint,
    workflows: restored.value.draft,
  };
  expect(v.safeParse(saveRepoWorkflowsInputSchema, input).success).toBe(false);
  const repaired = structuredClone(input);
  repaired.workflows!.profiles[0].environmentRefs = ['TEST_TOKEN'];
  expect(v.safeParse(saveRepoWorkflowsInputSchema, repaired).success).toBe(
    true,
  );
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
