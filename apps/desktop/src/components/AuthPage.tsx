import { useState } from 'react';
import type { FormEvent } from 'react';
import { formatAuthError, signInWithEmail, signUpWithEmail } from '@yard-1/firebase';

type Mode = 'sign-in' | 'sign-up';

export function AuthPage() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError('Email and password are required.');
      return;
    }

    if (mode === 'sign-up') {
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
      if (password.length < 6) {
        setError('Password should be at least 6 characters.');
        return;
      }
    }

    setSubmitting(true);
    try {
      if (mode === 'sign-in') {
        await signInWithEmail(trimmedEmail, password);
      } else {
        await signUpWithEmail(trimmedEmail, password);
      }
    } catch (err) {
      setError(formatAuthError(err));
    } finally {
      setSubmitting(false);
    }
  }

  function toggleMode() {
    setError(null);
    setConfirmPassword('');
    setMode((current) => (current === 'sign-in' ? 'sign-up' : 'sign-in'));
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-50 px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-28 top-10 h-96 w-96 rounded-full bg-cyan-200/50 blur-3xl" />
        <div className="absolute -right-24 top-28 h-96 w-96 rounded-full bg-sky-200/40 blur-3xl" />
        <div className="absolute bottom-0 left-1/2 h-72 w-[46rem] -translate-x-1/2 bg-gradient-to-r from-cyan-200/0 via-cyan-300/45 to-cyan-200/0 blur-3xl" />
      </div>

      <div className="relative w-full max-w-md overflow-hidden rounded-[2rem] border border-slate-200 bg-white/90 p-8 shadow-[0_24px_70px_-40px_rgba(14,116,144,0.35)] backdrop-blur sm:p-10">
        <div className="inline-flex items-center gap-2 rounded-full border border-cyan-200 bg-cyan-50 px-4 py-1.5 text-xs font-medium uppercase tracking-[0.24em] text-cyan-800">
          Buddy Tunnel
        </div>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-slate-900">
          {mode === 'sign-in' ? 'Sign in' : 'Create account'}
        </h1>
        <p className="mt-3 text-base leading-7 text-slate-600">
          {mode === 'sign-in'
            ? 'Sign in with your email and password to continue.'
            : 'Create an account to use Buddy Tunnel.'}
        </p>

        <form className="mt-8 space-y-4" onSubmit={onSubmit}>
          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-700">Email</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={submitting}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-900 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-200 disabled:opacity-60"
            />
          </label>

          <label className="block space-y-2">
            <span className="text-sm font-medium text-slate-700">Password</span>
            <input
              type="password"
              autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-900 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-200 disabled:opacity-60"
            />
          </label>

          {mode === 'sign-up' ? (
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Confirm password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={submitting}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-900 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-200 disabled:opacity-60"
              />
            </label>
          ) : null}

          {error ? <p className="text-sm leading-6 text-red-600">{error}</p> : null}

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex w-full items-center justify-center rounded-2xl bg-cyan-500 px-5 py-3 font-semibold text-white transition hover:bg-cyan-600 focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 focus:ring-offset-white disabled:cursor-not-allowed disabled:opacity-70"
          >
            {submitting ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <button
          type="button"
          onClick={toggleMode}
          disabled={submitting}
          className="mt-6 w-full text-center text-sm font-medium text-cyan-700 transition hover:text-cyan-800 disabled:opacity-60"
        >
          {mode === 'sign-in'
            ? "Don't have an account? Create one"
            : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}
