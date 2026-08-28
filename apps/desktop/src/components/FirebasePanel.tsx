import { isFirebaseInitialized, useRealtimeValue } from '@yard-1/firebase';

const STATUS_PATH = 'status';

export function FirebasePanel() {
  const configured = isFirebaseInitialized();
  const { data, loading, error } = useRealtimeValue<string | Record<string, unknown>>(STATUS_PATH);

  let content: string;
  if (!configured) {
    content =
      'Firebase is not configured. Copy apps/desktop/.env.example to .env.local and set your VITE_FIREBASE_* values, then restart the desktop app.';
  } else if (loading) {
    content = `Listening to /${STATUS_PATH}…`;
  } else if (error) {
    content = `Error: ${error.message}`;
  } else if (data === null) {
    content = `/${STATUS_PATH}: (null — write a value in the Firebase console)`;
  } else {
    content = `/${STATUS_PATH}:\n${JSON.stringify(data, null, 2)}`;
  }

  return (
    <section className="rounded-[2rem] border border-orange-200 bg-gradient-to-br from-orange-50 to-white p-6 shadow-[0_18px_36px_-28px_rgba(194,65,12,0.35)] sm:p-8">
      <div className="text-sm uppercase tracking-[0.3em] text-orange-700">
        Firebase Realtime Database
      </div>
      <pre className="mt-4 whitespace-pre-wrap text-sm leading-6 text-slate-700">{content}</pre>
    </section>
  );
}
