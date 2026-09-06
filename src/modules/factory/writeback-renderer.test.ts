import { expect, it } from 'vitest';
import { ValiError } from 'valibot';
import {
  publicStatusBody,
  type publicCodingStatusSchema,
} from '../../../shared/factory-writeback';
import type * as v from 'valibot';

type Facts = v.InferOutput<typeof publicCodingStatusSchema>;
it.each<[Facts['status'], string]>([
  ['reserved', 'Queued — awaiting coding dispatch'],
  ['running', 'Coding in progress'],
  ['collecting', 'Collecting coding output — not yet a candidate'],
  ['needs-reconcile', 'execution state is uncertain'],
  ['candidate', 'awaiting human review'],
  ['failed', 'Coding failed'],
  ['cancelled', 'Coding cancelled'],
])('projects only finite %s facts', (status, label) => {
  const body = publicStatusBody('queued', 'Approved public scope', {
    status,
    cancellationRequested: false,
  });
  expect(body).toContain(label);
  expect(body).toContain('Approved public scope');
  expect(body).not.toContain('No coding executor has been started');
  expect(body).not.toContain('Released — awaiting coding executor');
  expect(body).toContain(
    'does not imply task completion, verification, or publication',
  );
});
it('keeps cancellation uncertainty and release invalidation distinct', () => {
  expect(
    publicStatusBody('review', undefined, {
      status: 'running',
      cancellationRequested: true,
    }),
  ).toContain('awaiting confirmed stop');
  const body = publicStatusBody('review', undefined, {
    status: 'needs-reconcile',
    cancellationRequested: true,
  });
  expect(body).toContain('release is not currently eligible');
  expect(body).toContain('execution state is uncertain');
});
it('preserves the no-run template and rejects accidental private fields', () => {
  expect(publicStatusBody('queued')).toBe(
    '### Neon factory\n\nReleased — awaiting coding executor\n\nNo coding executor has been started.',
  );
  const facts = {
    status: 'running' as const,
    cancellationRequested: false,
    ownershipToken: 'private',
  };
  expect(() => publicStatusBody('queued', undefined, facts)).toThrow(ValiError);
});
