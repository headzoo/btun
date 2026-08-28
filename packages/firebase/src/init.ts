import { getApp, getApps, initializeApp } from 'firebase/app';
import type { FirebaseApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import type { Database } from 'firebase/database';

import type { FirebaseConfig } from './config';

export interface FirebaseServices {
  app: FirebaseApp;
  db: Database;
}

let services: FirebaseServices | null = null;

export function initFirebase(config: FirebaseConfig): FirebaseServices {
  if (services) {
    return services;
  }

  const app = getApps().length > 0 ? getApp() : initializeApp(config);
  const db = getDatabase(app);

  services = { app, db };
  return services;
}

export function getFirebase(): FirebaseServices {
  if (!services) {
    throw new Error('Firebase has not been initialized. Call initFirebase() first.');
  }
  return services;
}

export function isFirebaseInitialized(): boolean {
  return services !== null;
}
