import { describe, expect, it } from 'vitest';
import { formatAuthError, signInWithEmail, signOutUser, signUpWithEmail } from '@yard-1/firebase';

describe('formatAuthError', () => {
  it('maps known Firebase Auth error codes', () => {
    expect(formatAuthError({ code: 'auth/invalid-credential' })).toBe('Invalid email or password.');
    expect(formatAuthError({ code: 'auth/email-already-in-use' })).toBe(
      'An account with this email already exists.',
    );
    expect(formatAuthError({ code: 'auth/weak-password' })).toBe(
      'Password should be at least 6 characters.',
    );
    expect(formatAuthError({ code: 'auth/invalid-email' })).toBe('Enter a valid email address.');
    expect(formatAuthError({ code: 'auth/too-many-requests' })).toBe(
      'Too many attempts. Try again later.',
    );
  });

  it('falls back to Error.message for unknown errors', () => {
    expect(formatAuthError(new Error('Network down'))).toBe('Network down');
  });

  it('falls back to a generic message for unknown values', () => {
    expect(formatAuthError('nope')).toBe('Something went wrong. Please try again.');
    expect(formatAuthError(null)).toBe('Something went wrong. Please try again.');
  });
});

describe('auth helpers without init', () => {
  it('signInWithEmail throws when Firebase is not initialized', async () => {
    await expect(signInWithEmail('a@b.com', 'secret')).rejects.toThrow(
      'Firebase has not been initialized',
    );
  });

  it('signUpWithEmail throws when Firebase is not initialized', async () => {
    await expect(signUpWithEmail('a@b.com', 'secret')).rejects.toThrow(
      'Firebase has not been initialized',
    );
  });

  it('signOutUser throws when Firebase is not initialized', async () => {
    await expect(signOutUser()).rejects.toThrow('Firebase has not been initialized');
  });
});
