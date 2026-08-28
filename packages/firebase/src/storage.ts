import { push, ref, set } from 'firebase/database';

import { getFirebase } from './init';

export interface StorageItem {
  createdAt: number;
  message: string;
}

/** Push-ID keyed map under storage/{uid} */
export type StorageItemMap = Record<string, StorageItem>;

export const MAX_STORAGE_MESSAGE_LENGTH = 10000;

export function storagePath(uid: string): string {
  return `storage/${uid}`;
}

/**
 * Create a storage item under storage/{uid}/{pushId}.
 * Returns the new push ID.
 */
export async function saveStorageItem(uid: string, message: string): Promise<string> {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error('Message must not be empty.');
  }
  if (trimmed.length > MAX_STORAGE_MESSAGE_LENGTH) {
    throw new Error(`Message must be at most ${MAX_STORAGE_MESSAGE_LENGTH} characters.`);
  }

  const { db } = getFirebase();
  const itemRef = push(ref(db, storagePath(uid)));
  const item: StorageItem = {
    createdAt: Date.now(),
    message: trimmed,
  };
  await set(itemRef, item);

  if (!itemRef.key) {
    throw new Error('Failed to create storage item.');
  }
  return itemRef.key;
}
