/// <reference types="vite/client" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
// import { DesktopApp } from './DesktopApp';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root was not found.');
createRoot(root).render(
  <StrictMode>
    {/* <DesktopApp /> */}
    <div>123123</div>
  </StrictMode>
);
