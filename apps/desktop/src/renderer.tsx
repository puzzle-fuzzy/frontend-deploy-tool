/**
 * This file is loaded by Vite and runs in the "renderer" context.
 * It mounts the root React component into #root in index.html.
 *
 * To learn more about the differences between the "main" and "renderer"
 * context in Electron, visit:
 * https://electronjs.org/docs/tutorial/process-model
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';

import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
