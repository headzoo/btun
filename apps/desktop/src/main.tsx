import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

import './index.css';

import './demos/ipc';
import { ensureFirebase } from './lib/firebase';

// Initialize Firebase as early as possible (no-op if env vars are missing).
ensureFirebase();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

postMessage({ payload: 'removeLoading' }, '*');
