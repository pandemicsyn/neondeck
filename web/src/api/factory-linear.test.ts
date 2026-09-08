import { afterEach, expect, it, vi } from 'vitest';
import {
  getFactoryLinear,
  saveFactoryLinear,
  syncFactoryLinearSource,
} from './factory-linear';
import { getJson, postJson } from './http';
vi.mock('./http', () => ({ getJson: vi.fn(), postJson: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it('rejects malformed successful reads and mutation acknowledgements', async () => {
  vi.mocked(getJson).mockResolvedValue({});
  vi.mocked(postJson).mockResolvedValue({});
  await expect(getFactoryLinear()).rejects.toThrow();
  await expect(saveFactoryLinear([], 'fingerprint')).rejects.toThrow();
  await expect(syncFactoryLinearSource('task')).rejects.toThrow();
});
it('encodes source identifiers and requires the accepted sync contract', async () => {
  vi.mocked(postJson).mockResolvedValue({ accepted: true });
  await expect(syncFactoryLinearSource('task/one')).resolves.toEqual({
    accepted: true,
  });
  expect(postJson).toHaveBeenCalledWith(
    '/api/factory/work/task%2Fone/linear/sync',
    {},
  );
});
