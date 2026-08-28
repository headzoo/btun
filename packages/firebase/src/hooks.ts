import { onValue, ref } from 'firebase/database';
import { useEffect, useState } from 'react';

import { getFirebase, isFirebaseInitialized } from './init';

export interface RealtimeValueState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Subscribe to a Realtime Database path and return the live value.
 * Requires initFirebase() to have been called first.
 */
export function useRealtimeValue<T = unknown>(refPath: string): RealtimeValueState<T> {
  const [state, setState] = useState<RealtimeValueState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!isFirebaseInitialized()) {
      setState({
        data: null,
        loading: false,
        error: new Error('Firebase has not been initialized. Call initFirebase() first.'),
      });
      return;
    }

    const { db } = getFirebase();
    const dbRef = ref(db, refPath);

    const unsubscribe = onValue(
      dbRef,
      (snapshot) => {
        setState({
          data: snapshot.exists() ? (snapshot.val() as T) : null,
          loading: false,
          error: null,
        });
      },
      (error) => {
        setState({
          data: null,
          loading: false,
          error,
        });
      },
    );

    return () => unsubscribe();
  }, [refPath]);

  return state;
}
