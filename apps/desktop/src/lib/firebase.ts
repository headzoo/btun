import { initFirebase, isFirebaseInitialized } from '@yard-1/firebase';

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
    return false;
  }

  initFirebase({
    apiKey,
    authDomain,
    databaseURL,
    projectId,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  });

  return true;
}
