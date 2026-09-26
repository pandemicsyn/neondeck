import './factory/factory.css';
import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getJson } from '../api/http';

const FactoryPageContent = lazy(() =>
  import('./factory/FactoryPage').then((module) => ({
    default: module.FactoryPage,
  })),
);

function useFeatures() {
  return useQuery({
    queryKey: ['features'],
    queryFn: ({ signal }) =>
      getJson<{ factory: boolean }>('/api/features', { signal }),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

export function FactoryNav() {
  const features = useFeatures();
  return features.data?.factory ? (
    <a className="factory-nav" href="/factory">
      Factory inbox
    </a>
  ) : null;
}

export function FactoryPage() {
  const features = useFeatures();
  if (features.isPending) return <main>Loading…</main>;
  if (!features.data?.factory) {
    return (
      <main>
        <p>
          {features.isError
            ? 'Could not load enabled features.'
            : 'Factory is unavailable.'}
        </p>
        <a href="/">Back to dashboard</a>
      </main>
    );
  }
  return (
    <Suspense fallback={<main>Loading…</main>}>
      <FactoryPageContent />
    </Suspense>
  );
}
