/// <reference types="vite/client" />
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

function Probe() {
  const [origin, setOrigin] = useState('(loading)');
  useEffect(() => {
    window.deploykit.native.getServerOrigin().then(setOrigin);
  }, []);
  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h1>DeployKit Desktop</h1>
      <p>
        Configured server: <code>{origin || '(none)'}</code>
      </p>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root was not found.');
createRoot(root).render(
  <StrictMode>
    <Probe />
  </StrictMode>
);
