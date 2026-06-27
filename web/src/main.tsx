import { FlueProvider } from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const client = createFlueClient({
  baseUrl: '/api/flue',
  fetch: (input, init) => fetch(input, init),
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FlueProvider client={client}>
      <App />
    </FlueProvider>
  </StrictMode>,
);
