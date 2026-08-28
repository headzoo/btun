import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import type { UserCredential } from 'firebase/auth';

import { getFirebase } from './init';

function requireAuth() {
  return getFirebase().auth;
}

export async function signInWithEmail(email: string, password: string): Promise<UserCredential> {
  return signInWithEmailAndPassword(requireAuth(), email.trim(), password);
}

export async function signUpWithEmail(email: string, password: string): Promise<UserCredential> {
  return createUserWithEmailAndPassword(requireAuth(), email.trim(), password);
}

export async function signOutUser(): Promise<void> {
  return signOut(requireAuth());
}

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  'auth/email-already-in-use': 'An account with this email already exists.',
  'auth/invalid-credential': 'Invalid email or password.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/operation-not-allowed': 'Email/password sign-in is not enabled for this project.',
  'auth/too-many-requests': 'Too many attempts. Try again later.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/user-not-found': 'Invalid email or password.',
  'auth/weak-password': 'Password should be at least 6 characters.',
  'auth/wrong-password': 'Invalid email or password.',
};

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Map Firebase Auth error codes to short, user-facing messages.
 */
export function formatAuthError(error: unknown): string {
  const code = getErrorCode(error);
  if (code && AUTH_ERROR_MESSAGES[code]) {
    return AUTH_ERROR_MESSAGES[code];
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}
