import { useEffect, useState } from 'react';

type VaultStatusSnapshot = {
  rootPath: string | null;
  rootDisplayName: string | null;
  usingDefaultRoot: boolean;
};

export interface VaultSettingsProps {
  busy: boolean;
  onChangeRoot: (mode: 'choose' | 'default') => Promise<void>;
  onClose: () => void;
}

export function VaultSettings({ busy, onChangeRoot, onClose }: VaultSettingsProps) {
  const [status, setStatus] = useState<VaultStatusSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [confirmDefault, setConfirmDefault] = useState(false);

  async function refreshStatus() {
    setLoading(true);
    setError(null);
    try {
      const result = await window.buddyTunnel.getStatus();
      if (!result.ok) {
        setStatus(null);
        setError(result.error.message);
        return;
      }
      setStatus({
        rootPath: result.value.rootPath,
        rootDisplayName: result.value.rootDisplayName,
        usingDefaultRoot: result.value.usingDefaultRoot,
      });
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : 'Failed to read vault status.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
  }, []);

  async function run(action: () => Promise<void>) {
    setActing(true);
    setError(null);
    try {
      await action();
      await refreshStatus();
      setConfirmDefault(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Vault settings action failed.');
    } finally {
      setActing(false);
    }
  }

  const blocked = busy || acting || loading;

  return (
    <section
      aria-label="Vault settings"
      className="rounded-[1.5rem] border border-slate-200 bg-slate-50/80 p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
            Vault folder
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Changing the vault root leaves the previous folder untouched and materializes synced
            files into the newly selected folder.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-300"
        >
          Close
        </button>
      </div>

      <div className="mt-4 space-y-2 rounded-2xl border border-slate-200 bg-white p-4">
        {loading ? (
          <p className="text-sm text-slate-500">Loading vault location…</p>
        ) : (
          <>
            <div className="text-sm font-medium text-slate-900">
              {status?.rootDisplayName ?? 'No vault folder'}
              {status?.usingDefaultRoot ? (
                <span className="ml-2 text-xs font-normal uppercase tracking-[0.18em] text-cyan-700">
                  Default
                </span>
              ) : null}
            </div>
            <p className="break-all text-xs leading-5 text-slate-500">
              {status?.rootPath ?? 'Vault is not started.'}
            </p>
          </>
        )}
      </div>

      {error ? (
        <p className="mt-3 text-sm text-rose-700" role="alert">
          {error}
        </p>
      ) : null}

      {confirmDefault ? (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <p>
            Reset to the default folder? Your current vault folder stays on disk; synced files will
            be materialized into the default Buddy Tunnel location.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={blocked}
              onClick={() => void run(() => onChangeRoot('default'))}
              className="rounded-xl bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              Reset to default
            </button>
            <button
              type="button"
              disabled={blocked}
              onClick={() => setConfirmDefault(false)}
              className="rounded-xl border border-amber-200 bg-white px-3 py-1.5 text-xs font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={blocked}
          onClick={() => void run(() => onChangeRoot('choose'))}
          className="rounded-2xl bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700 disabled:cursor-not-allowed disabled:bg-cyan-300"
        >
          Choose folder…
        </button>
        <button
          type="button"
          disabled={blocked || Boolean(status?.usingDefaultRoot)}
          onClick={() => setConfirmDefault(true)}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-cyan-300 hover:text-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Use default
        </button>
        <button
          type="button"
          disabled={blocked || !status?.rootPath}
          onClick={() =>
            void run(async () => {
              const result = await window.buddyTunnel.revealRoot();
              if (!result.ok) {
                throw new Error(result.error.message);
              }
            })
          }
          className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-cyan-300 hover:text-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reveal in OS
        </button>
      </div>
    </section>
  );
}
