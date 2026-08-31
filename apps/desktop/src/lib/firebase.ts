import { initFirebase, isFirebaseInitialized } from '@yard-1/firebase';

import { verboseLog } from '@/lib/verbose';

/**
 * Initialize Firebase from Vite env vars.
 * Copy .env.example to .env.local and fill in your Firebase project values.
 */
export function ensureFirebase(): boolean {
  if (isFirebaseInitialized()) {
    return true;
  }

  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
  const databaseURL = import.meta.env.VITE_FIREBASE_DATABASE_URL;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;

  if (!apiKey || !authDomain || !databaseURL || !projectId) {
    verboseLog('firebase', 'missing required env vars', {
      hasApiKey: Boolean(apiKey),
      hasAuthDomain: Boolean(authDomain),
      hasDatabaseURL: Boolean(databaseURL),
      hasProjectId: Boolean(projectId),
    });
    return false;
  }

  verboseLog('firebase', 'initializing', { projectId, databaseURL });
  initFirebase({
    apiKey,
    authDomain,
    databaseURL,
    projectId,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  });

  verboseLog('firebase', 'initialized');
  return true;
}
