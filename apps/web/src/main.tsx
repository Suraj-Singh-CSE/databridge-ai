import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';

import App from '@/App';

import './index.css';

// Zod would probe `new Function` to compile faster validators; the CSP forbids eval
// (script-src 'self', docs/adr/0027-same-origin-and-access.md), so use the plain validators.
z.config({ jitless: true });

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
