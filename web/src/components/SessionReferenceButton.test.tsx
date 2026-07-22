import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionReferenceButton } from './SessionReferenceButton';

describe('SessionReferenceButton', () => {
  it('uses a row-specific accessible name and a clear visible label', () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SessionReferenceButton
          kind="watch"
          linkedWatchId="watch-42"
          title="Watch neondeck#140"
        />
      </QueryClientProvider>,
    );

    expect(html).toContain('aria-label="Open chat for Watch neondeck#140"');
    expect(html).toContain('>chat</button>');
    expect(html).not.toContain('>session</button>');
  });
});
