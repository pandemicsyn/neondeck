import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { buildPreparedDiffAuditSummary } from './modules/autonomous-audit';
import { arrayField, numberArrayField } from './modules/autopilot/utils';
import { isJsonValue } from './modules/execution/utils';
import { prEventWatermarkTruncationCategories } from './modules/github/state-truncation';
import {
  createOptionalKiloSdkClient,
  resolveKiloSessionsSearchMethod,
} from './modules/kilo/sessions-adapters';
import { branchCanLikelyPush } from './modules/kilo/results/state';
import { readJsonArray, stableJson } from './modules/scheduler/utils';

describe('anti-slop helper compatibility regressions', () => {
  it('retains valid elements from mixed external arrays', () => {
    const value = {
      requires: ['repository', 7, 'worktree', null],
      checkRunIds: [101, 'bad', 202, null],
    };

    expect(arrayField(value, 'requires')).toEqual(['repository', 'worktree']);
    expect(numberArrayField(value, 'checkRunIds')).toEqual([101, 202]);
    expect(
      readJsonArray(['commits', undefined, { category: 'checks' }]),
    ).toEqual(['commits', { category: 'checks' }]);
  });

  it('canonicalizes unsupported nested scheduler values', () => {
    const first = {
      z: undefined,
      a: { y: 1n, x: 'retained' },
    };
    const second = {
      a: { x: 'retained', y: 2n },
      z: undefined,
    };

    expect(stableJson(first)).toBe(stableJson(second));
    expect(stableJson(first)).toContain('"a"');
  });

  it('reads nested Kilo booleans from prototype-backed objects', () => {
    class PermissionData {
      get canLikelyPush() {
        return true;
      }
    }
    class PermissionEnvelope {
      readonly data = new PermissionData();
    }

    expect(
      branchCanLikelyPush({
        branchPermissions: new PermissionEnvelope().data,
      }),
    ).toBe(true);
  });

  it('keeps null unavailable reasons out of truncation categories', () => {
    expect(
      prEventWatermarkTruncationCategories([
        {
          category: 'check_runs',
          value: { truncated: false, unavailableReason: null },
        },
      ]),
    ).toEqual([]);
  });

  it('omits missing check run IDs from autonomous audit facts', () => {
    const summary = buildPreparedDiffAuditSummary({
      preparedDiff: {
        id: 'prepared-1',
        worktreeId: 'worktree-1',
        repoId: 'repo-1',
        repoFullName: 'owner/repo',
        prNumber: 42,
        title: 'Prepared diff',
        sourceWorktreePath: '/tmp/worktree',
        baseRef: 'main',
        headRef: 'feature',
        headSha: null,
        status: 'prepared',
        pushApprovalStatus: 'not-requested',
        verificationStatus: 'not-run',
        summary: {
          diagnostics: [{ command: 'npm test', ok: false }],
        },
        sourceOfTruth: 'worktree',
        createdBy: 'test',
        createdAt: '2026-08-21T00:00:00.000Z',
        updatedAt: '2026-08-21T00:00:00.000Z',
        abandonedAt: null,
      },
    });
    const facts = v.parse(
      v.object({ checkRunIds: v.array(v.number()) }),
      summary.facts,
    );

    expect(facts.checkRunIds).toEqual([]);
  });

  it('rejects values that cannot round-trip as JSON', () => {
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue({ value: undefined })).toBe(false);
    expect(isJsonValue({ value: () => undefined })).toBe(false);
    expect(isJsonValue({ value: Number.NaN })).toBe(false);
    expect(isJsonValue(new Date('2026-08-21T00:00:00.000Z'))).toBe(false);
    expect(isJsonValue({ value: [null, 'ok', 1] })).toBe(true);
  });

  it('uses valid Kilo fallbacks when sibling methods are malformed', () => {
    class KiloClient {
      readonly source = 'constructor';
    }
    const client = createOptionalKiloSdkClient({
      default: {},
      createClient: null,
      KiloClient,
    });
    const list = vi.fn<() => void>();

    expect(client).toBeInstanceOf(KiloClient);
    expect(resolveKiloSessionsSearchMethod({ search: null, list })).toBe(list);
  });

  it('finds Kilo session methods inherited from a class prototype', () => {
    class SessionsApi {
      search() {
        return [];
      }
    }

    const api = new SessionsApi();
    expect(resolveKiloSessionsSearchMethod(api)).toBe(api.search);
  });

  it('preserves the SDK module receiver when creating a Kilo client', () => {
    const sdkModule = {
      default: {},
      createClient(this: { token: string }) {
        return { token: this.token };
      },
    };
    Object.defineProperty(sdkModule, 'token', {
      value: 'sdk-token',
      enumerable: false,
    });
    const client = createOptionalKiloSdkClient(sdkModule);

    expect(client).toEqual({ token: 'sdk-token' });
  });

  it('uses a default-exported Kilo client factory when named exports are absent', () => {
    const client = createOptionalKiloSdkClient({
      default: {
        token: 'default-token',
        createClient(this: { token: string }) {
          return { token: this.token };
        },
      },
      createClient: null,
      KiloClient: null,
    });

    expect(client).toEqual({ token: 'default-token' });
  });

  it('does not recurse through a self-referential default export', () => {
    const client = { sessions: { list: vi.fn<() => void>() } };
    const sdkModule = {
      createClient() {
        return client;
      },
    };
    Object.defineProperty(sdkModule, 'default', {
      value: sdkModule,
      enumerable: true,
    });

    expect(createOptionalKiloSdkClient(sdkModule)).toBe(client);
  });
});
