import type { ReactNode } from 'react';
import { isFirebaseInitialized, useAuth } from '@yard-1/firebase';

import { AuthPage } from '@/components/AuthPage';
import { verboseLog } from '@/lib/verbose';

interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const configured = isFirebaseInitialized();
  const { user, loading } = useAuth();

  if (!configured) {
    verboseLog('auth', 'firebase not configured');
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-50 px-4 py-8 text-slate-900">
        <div className="w-full max-w-lg rounded-[2rem] border border-slate-200 bg-white/90 p-8 shadow-[0_24px_70px_-40px_rgba(14,116,144,0.35)] backdrop-blur">
          <div className="text-sm uppercase tracking-[0.3em] text-cyan-700">Firebase</div>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-slate-900">
            Firebase is not configured
          </h1>
          <p className="mt-3 text-base leading-7 text-slate-600">
            Copy apps/desktop/.env.example to .env.local and set your VITE_FIREBASE_* values, then
            restart the desktop app. Enable Email/Password sign-in in the Firebase Console.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    verboseLog('auth', 'waiting for auth state');
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-50 px-4 py-8 text-slate-900">
        <div className="rounded-[2rem] border border-slate-200 bg-white/90 px-8 py-6 text-sm font-medium uppercase tracking-[0.24em] text-slate-500 shadow-sm backdrop-blur">
          Loading…
        </div>
      </div>
    );
  }

  if (!user) {
    verboseLog('auth', 'signed out');
    return <AuthPage />;
  }

  verboseLog('auth', 'signed in', { uid: user.uid });
  return children;
}
