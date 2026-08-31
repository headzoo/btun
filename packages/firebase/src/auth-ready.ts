import type { User } from 'firebase/auth';

import { getFirebase } from './init';

const RTDB_READ_TIMEOUT_MS = 20_000;

export async function waitForAuthUser(expectedUid?: string): Promise<User> {
  const { auth } = getFirebase();
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Not signed in to Firebase.');
  }
  if (expectedUid && user.uid !== expectedUid) {
    throw new Error(`Firebase auth uid does not match vault uid (${expectedUid}).`);
  }
  await user.getIdToken();
  return user;
}

export function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  ms = RTDB_READ_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function databaseRestBaseUrl(): string {
  const { app } = getFirebase();
  const databaseURL = app.options.databaseURL;
  if (typeof databaseURL !== 'string' || databaseURL.length === 0) {
    throw new Error('Firebase databaseURL is not configured.');
  }
  return databaseURL.replace(/\/$/, '');
}

function restUrl(path: string, idToken: string): string {
  const encodedPath = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join('/');
  return `${databaseRestBaseUrl()}/${encodedPath}.json?auth=${encodeURIComponent(idToken)}`;
}

/** One-shot RTDB read via HTTPS (reliable in Electron when the SDK transport hangs). */
export async function rtdbRestGet(path: string, idToken: string): Promise<unknown> {
  const response = await withTimeout(fetch(restUrl(path, idToken)), `RTDB REST read ${path}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`RTDB REST read ${path} failed (${response.status}): ${text}`);
  }
  return response.json();
}

/** One-shot RTDB write via HTTPS PUT. */
export async function rtdbRestPut(path: string, idToken: string, body: unknown): Promise<void> {
  const payload = JSON.stringify(body);
  const response = await withTimeout(
    fetch(restUrl(path, idToken), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }),
    `RTDB REST write ${path}`,
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`RTDB REST write ${path} failed (${response.status}): ${text} body=${payload}`);
  }
}

/** One-shot RTDB write via HTTPS PATCH. */
export async function rtdbRestPatch(path: string, idToken: string, body: unknown): Promise<void> {
  const payload = JSON.stringify(body);
  const response = await withTimeout(
    fetch(restUrl(path, idToken), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }),
    `RTDB REST patch ${path}`,
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`RTDB REST patch ${path} failed (${response.status}): ${text}`);
  }
}
