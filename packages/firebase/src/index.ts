export type { FirebaseConfig } from './config';
export { formatAuthError, signInWithEmail, signOutUser, signUpWithEmail } from './auth';
export { useRealtimeValue } from './hooks';
export type { RealtimeValueState } from './hooks';
export {
  getFirebase,
  initFirebase,
  isFirebaseInitialized,
  isStorageConfigured,
  requireFirebaseStorage,
} from './init';
export type { FirebaseServices } from './init';
export { useAuth } from './useAuth';
export type { AuthState } from './useAuth';
export { rtdbRestGet, waitForAuthUser, withTimeout } from './auth-ready';
export { createFirebaseVaultTransport } from './vault-transport';
export { storagePath } from './storage';
