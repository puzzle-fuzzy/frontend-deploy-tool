/// <reference types="vite/client" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ApiClientProvider, createFetchApiClient } from '@deploykit/client';
import './index.css';

const client = createFetchApiClient();

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root was not found.');

createRoot(root).render(
  <StrictMode>
    <ApiClientProvider client={client}>
      <App />
    </ApiClientProvider>
  </StrictMode>
);
