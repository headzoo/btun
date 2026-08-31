import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

import './index.css';

import { ensureFirebase } from './lib/firebase';
import { verboseLog } from './lib/verbose';

// Initialize Firebase as early as possible (no-op if env vars are missing).
const firebaseReady = ensureFirebase();
verboseLog('startup', 'renderer boot', {
  firebaseReady,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? null,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL ?? null,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? null,
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

postMessage({ payload: 'removeLoading' }, '*');
