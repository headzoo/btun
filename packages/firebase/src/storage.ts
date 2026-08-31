import { rtdbLiveRoot } from '@yard-1/vault';

/** RTDB path for live vault records: `storage/{uid}`. */
export function storagePath(uid: string): string {
  return rtdbLiveRoot(uid);
}
