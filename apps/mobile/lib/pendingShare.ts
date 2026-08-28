import { Platform } from 'react-native';
import { getSharedPayloads } from 'expo-sharing';

/** True when the OS has handed the app a share payload that is not yet cleared. */
export function hasPendingSharedPayloads(): boolean {
  if (Platform.OS === 'web') {
    return false;
  }
  try {
    return getSharedPayloads().length > 0;
  } catch {
    return false;
  }
}
