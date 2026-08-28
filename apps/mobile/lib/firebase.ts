import { initFirebase, isFirebaseInitialized } from '@yard-1/firebase';

/**
 * Initialize Firebase from Expo public env vars.
 * Copy .env.example to .env.local and fill in your Firebase project values.
 */
export function ensureFirebase(): boolean {
  if (isFirebaseInitialized()) {
    return true;
  }

  const apiKey = process.env.EXPO_PUBLIC_FIREBASE_API_KEY;
  const authDomain = process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN;
  const databaseURL = process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL;
  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;

  if (!apiKey || !authDomain || !databaseURL || !projectId) {
    return false;
  }

  initFirebase({
    apiKey,
    authDomain,
    databaseURL,
    projectId,
    storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
  });

  return true;
}
