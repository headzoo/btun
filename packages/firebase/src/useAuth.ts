import { onAuthStateChanged } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { useEffect, useState } from 'react';

import { getFirebase, isFirebaseInitialized } from './init';

export interface AuthState {
  user: User | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Subscribe to Firebase Auth state. Requires initFirebase() first.
 */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!isFirebaseInitialized()) {
      setState({
        user: null,
        loading: false,
        error: new Error('Firebase has not been initialized. Call initFirebase() first.'),
      });
      return;
    }

    const { auth } = getFirebase();
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        setState({
          user,
          loading: false,
          error: null,
        });
      },
      (error) => {
        setState({
          user: null,
          loading: false,
          error,
        });
      },
    );

    return () => unsubscribe();
  }, []);

  return state;
}
