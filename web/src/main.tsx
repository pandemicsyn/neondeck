import { FlueProvider } from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getLocalApiSession } from './api/local-api-session';
import { queryClient } from './lib/query';
import './styles.css';

const client = createFlueClient({
  baseUrl: '/api/flue',
  fetch: async (input, init) => {
    const session = await getLocalApiSession();
    const headers = new Headers(init?.headers);
    if (session?.token) {
      headers.set(session.header || 'x-neondeck-api-token', session.token);
    }

    return fetch(input, { ...init, headers });
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <FlueProvider client={client}>
        <App />
      </FlueProvider>
    </QueryClientProvider>
  </StrictMode>,
);
