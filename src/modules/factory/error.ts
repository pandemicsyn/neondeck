import type { FactoryDetail } from '../../../shared/factory';
export class FactoryError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409,
    message: string,
    public current?: FactoryDetail,
  ) {
    super(message);
  }
}
