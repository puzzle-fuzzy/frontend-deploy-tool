import {
  ApiClientProvider,
  App,
  createFetchApiClient,
} from '@deploykit/client';
import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <Suspense>
      <ApiClientProvider client={createFetchApiClient()}>
        <App />
      </ApiClientProvider>
    </Suspense>
  </StrictMode>
);
