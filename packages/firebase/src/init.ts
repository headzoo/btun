import { getApp, getApps, initializeApp } from 'firebase/app';
import type { FirebaseApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import type { Auth } from 'firebase/auth';
import { getDatabase } from 'firebase/database';
import type { Database } from 'firebase/database';
import { getStorage } from 'firebase/storage';
import type { FirebaseStorage } from 'firebase/storage';

import type { FirebaseConfig } from './config';

export interface FirebaseServices {
  app: FirebaseApp;
  auth: Auth;
  db: Database;
  storage: FirebaseStorage;
}

let services: FirebaseServices | null = null;

export function initFirebase(config: FirebaseConfig): FirebaseServices {
  if (services) {
    return services;
  }

  const app = getApps().length > 0 ? getApp() : initializeApp(config);
  const auth = getAuth(app);
  const db = getDatabase(app);
  const storage = getStorage(app);

  services = { app, auth, db, storage };
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

export function isStorageConfigured(): boolean {
  if (!services) {
    return false;
  }
  const bucket = services.app.options.storageBucket;
  return typeof bucket === 'string' && bucket.length > 0;
}

export function requireFirebaseStorage(): FirebaseStorage {
  const { storage, app } = getFirebase();
  const bucket = app.options.storageBucket;
  if (typeof bucket !== 'string' || bucket.length === 0) {
    throw new Error(
      'Firebase Storage is not configured. Set storageBucket before blob operations.',
    );
  }
  return storage;
}
