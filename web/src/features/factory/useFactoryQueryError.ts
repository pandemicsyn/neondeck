import { useState } from 'react';

/** Keep failed reads actionable while a no-data retry resets Query to pending.
 * This is display state only: success clears it and a new scope cannot inherit it.
 */
export function useFactoryQueryError(
  query: { error: Error | null; status: 'pending' | 'error' | 'success' },
  scope: string | undefined,
) {
  const [retained, setRetained] = useState({ scope, error: query.error });
  const error =
    query.error ??
    (query.status === 'pending' && retained.scope === scope
      ? retained.error
      : null);
  if (retained.scope !== scope || retained.error !== error) {
    setRetained({ scope, error });
  }
  return error;
}
