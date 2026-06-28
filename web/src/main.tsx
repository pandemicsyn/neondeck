import { FlueProvider } from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { queryClient } from './lib/query';
import './styles.css';

const client = createFlueClient({
  baseUrl: '/api/flue',
  fetch: (input, init) => fetch(input, init),
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
