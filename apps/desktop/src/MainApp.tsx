import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, ReactNode } from 'react';
import { signOutUser, useAuth } from '@yard-1/firebase';
import type { FileEntry } from '@yard-1/vault';
import UpdateElectron from '@/components/update';
import { VaultList } from '@/components/vault/VaultList';
import { VaultSettings } from '@/components/vault/VaultSettings';
import { VaultToolbar } from '@/components/vault/VaultToolbar';
import { useVault } from '@/hooks/useVault';
import { verboseLog } from '@/lib/verbose';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function MainApp() {
  const { user } = useAuth();
  const vault = useVault();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const dragDepth = useRef(0);

  const blocked =
    vault.rootStatus.kind === 'owner-mismatch' ||
    vault.rootStatus.kind === 'permission' ||
    vault.rootStatus.kind === 'error';
  const vaultStarting = vault.rootStatus.kind === 'idle';
  const listInteractive = !blocked && vault.rootStatus.kind === 'ready';
  const caseSensitiveNames = typeof navigator !== 'undefined' && /linux/i.test(navigator.platform);

  async function importFileList(files: File[]) {
    if (!listInteractive || files.length === 0) {
      return;
    }
    setImporting(true);
    setActionError(null);
    setActionNotice(null);
    try {
      verboseLog('import', 'importDroppedFiles begin', { count: files.length });
      const result = await window.buddyTunnel.importDroppedFiles(files);
      if (!result.ok) {
        verboseLog('import', 'importDroppedFiles failed', result.error);
        setActionError(result.error.message);
        return;
      }
      verboseLog('import', 'importDroppedFiles ok', { imported: result.value.length });
      await vault.commands.refresh({ localOnly: true });
      const count = result.value.length;
      setActionNotice(
        count === 0
          ? 'No files were imported.'
          : `Imported ${count} file${count === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      setActionError(errorMessage(error, 'Import failed.'));
    } finally {
      setImporting(false);
    }
  }

  useEffect(() => {
    function onWindowPaste(event: ClipboardEvent) {
      if (!listInteractive || importing) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }
      const files = event.clipboardData?.files;
      if (files && files.length > 0) {
        event.preventDefault();
        void importFileList(Array.from(files));
      }
    }
    window.addEventListener('paste', onWindowPaste);
    return () => window.removeEventListener('paste', onWindowPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paste gate uses interactive/importing flags
  }, [listInteractive, importing, vault.commands]);

  async function pasteImport() {
    if (!listInteractive || importing) {
      return;
    }
    setImporting(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const result = await window.buddyTunnel.importClipboard();
      if (!result.ok) {
        if (result.error.code === 'unsupported') {
          setActionError(
            'File paste from the OS clipboard is not supported in this environment. Use Add files or drag and drop instead.',
          );
        } else {
          setActionError(result.error.message);
        }
        return;
      }
      await vault.commands.refresh({ localOnly: true });
      const count = result.value.length;
      setActionNotice(
        count === 0
          ? 'Clipboard did not contain importable files.'
          : `Pasted ${count} file${count === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      setActionError(errorMessage(error, 'Paste import failed.'));
    } finally {
      setImporting(false);
    }
  }

  function onDragEnter(event: DragEvent<HTMLElement>) {
    if (!listInteractive) {
      return;
    }
    event.preventDefault();
    dragDepth.current += 1;
    setDropActive(true);
  }

  function onDragOver(event: DragEvent<HTMLElement>) {
    if (!listInteractive) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(event: DragEvent<HTMLElement>) {
    if (!listInteractive) {
      return;
    }
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) {
      setDropActive(false);
    }
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    if (!listInteractive) {
      return;
    }
    event.preventDefault();
    dragDepth.current = 0;
    setDropActive(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    void importFileList(files);
  }

  async function openEntry(entry: FileEntry) {
    if (entry.status !== 'ready') {
      setActionError('Wait until the file is ready before opening.');
      return;
    }
    setActionError(null);
    const result = await window.buddyTunnel.open(entry.localName);
    if (!result.ok) {
      setActionError(result.error.message);
    }
  }

  async function revealEntry(entry: FileEntry) {
    setActionError(null);
    const result = await window.buddyTunnel.reveal(entry.localName);
    if (!result.ok) {
      setActionError(result.error.message);
    }
  }

  async function dragOut(entry: FileEntry) {
    if (entry.status !== 'ready') {
      return;
    }
    setActionError(null);
    const result = await window.buddyTunnel.startDrag(entry.localName);
    if (!result.ok) {
      setActionError(result.error.message);
    }
  }

  async function renameEntry(entry: FileEntry, nextName: string) {
    setBusyId(entry.id);
    setActionError(null);
    try {
      await vault.commands.rename(entry.id, nextName);
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) {
      return;
    }
    setDeleting(true);
    setActionError(null);
    setBusyId(deleteTarget.id);
    try {
      await vault.commands.remove(deleteTarget.id);
      setActionNotice(`Deleted ${deleteTarget.localName}.`);
      setDeleteTarget(null);
    } catch (error) {
      setActionError(errorMessage(error, 'Delete failed.'));
    } finally {
      setDeleting(false);
      setBusyId(null);
    }
  }

  let blockingPanel: ReactNode = null;
  if (vault.rootStatus.kind === 'owner-mismatch') {
    blockingPanel = (
      <section className="rounded-[1.75rem] border border-amber-200 bg-amber-50 p-6 text-amber-950">
        <h2 className="text-lg font-semibold">Vault belongs to another account</h2>
        <p className="mt-2 text-sm leading-6">
          {vault.rootStatus.message} Buddy Tunnel will not ingest or overwrite this folder. Choose a
          different empty folder or restore the default vault location.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void vault.commands.changeRoot('choose')}
            className="rounded-2xl bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700"
          >
            Choose another folder…
          </button>
          <button
            type="button"
            onClick={() => void vault.commands.changeRoot('default')}
            className="rounded-2xl border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-950 hover:border-amber-400"
          >
            Use default vault
          </button>
        </div>
      </section>
    );
  } else if (vault.rootStatus.kind === 'permission' || vault.rootStatus.kind === 'error') {
    blockingPanel = (
      <section className="rounded-[1.75rem] border border-rose-200 bg-rose-50 p-6 text-rose-950">
        <h2 className="text-lg font-semibold">Vault unavailable</h2>
        <p className="mt-2 text-sm leading-6">{vault.rootStatus.message}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void vault.commands.changeRoot('choose')}
            className="rounded-2xl bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700"
          >
            Choose folder…
          </button>
          <button
            type="button"
            onClick={() => void vault.commands.changeRoot('default')}
            className="rounded-2xl border border-rose-300 bg-white px-4 py-2 text-sm font-semibold text-rose-950"
          >
            Use default vault
          </button>
          <button
            type="button"
            onClick={() => void vault.commands.refresh()}
            className="rounded-2xl border border-rose-300 bg-white px-4 py-2 text-sm font-semibold text-rose-950"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-50 px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-28 top-10 h-96 w-96 rounded-full bg-cyan-200/50 blur-3xl" />
        <div className="absolute -right-24 top-28 h-96 w-96 rounded-full bg-sky-200/40 blur-3xl" />
        <div className="absolute bottom-0 left-1/2 h-72 w-[46rem] -translate-x-1/2 bg-gradient-to-r from-cyan-200/0 via-cyan-300/45 to-cyan-200/0 blur-3xl" />
      </div>

      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-800">
              Buddy Tunnel
            </p>
            <p className="mt-1 truncate text-sm text-slate-600">
              Signed in as <span className="font-medium text-slate-900">{user?.email}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <UpdateElectron />
            <button
              type="button"
              onClick={() => {
                void signOutUser();
              }}
              className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-cyan-300 hover:text-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 focus:ring-offset-slate-50"
            >
              Sign out
            </button>
          </div>
        </header>

        <VaultToolbar
          disabled={!listInteractive}
          importing={importing}
          settingsOpen={settingsOpen}
          fileInputRef={fileInputRef}
          onPickFiles={() => fileInputRef.current?.click()}
          onFilesChosen={(event: ChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            void importFileList(files);
          }}
          onPasteImport={() => void pasteImport()}
          onRefresh={() => void vault.commands.refresh()}
          onToggleSettings={() => setSettingsOpen((open) => !open)}
        />

        {settingsOpen ? (
          <VaultSettings
            busy={importing || busyId !== null}
            onChangeRoot={async (mode) => {
              setActionError(null);
              await vault.commands.changeRoot(mode);
              setActionNotice(
                mode === 'default'
                  ? 'Switched to the default vault folder.'
                  : 'Vault folder updated.',
              );
            }}
            onClose={() => setSettingsOpen(false)}
          />
        ) : null}

        {vaultStarting ? (
          <p className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
            Starting vault…
          </p>
        ) : null}

        {actionError ? (
          <p
            className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
            role="alert"
          >
            {actionError}
          </p>
        ) : null}
        {actionNotice ? (
          <p className="rounded-2xl border border-cyan-200 bg-cyan-50 px-4 py-3 text-sm text-cyan-900">
            {actionNotice}
          </p>
        ) : null}

        {blockingPanel}

        {!blocked ? (
          <VaultList
            entries={vault.entries}
            initialLoading={vault.initialLoading && !vault.bootstrapped}
            syncStatusLabel={vault.syncStatusLabel}
            dropActive={dropActive}
            busy={importing || busyId !== null}
            caseSensitiveNames={caseSensitiveNames}
            banner={
              dropActive ? (
                <span className="rounded-full border border-cyan-300 bg-cyan-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-800">
                  Drop to import
                </span>
              ) : null
            }
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onOpen={(entry) => void openEntry(entry)}
            onRename={renameEntry}
            onDelete={setDeleteTarget}
            onReveal={(entry) => void revealEntry(entry)}
            onDragOut={(entry) => void dragOut(entry)}
          />
        ) : null}
      </div>

      {deleteTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
          role="presentation"
          onClick={() => {
            if (!deleting) {
              setDeleteTarget(null);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="vault-delete-title"
            className="w-full max-w-md rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="vault-delete-title" className="text-lg font-semibold text-slate-900">
              Delete {deleteTarget.localName}?
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              This removes the file from this device and deletes it across synced devices. Cloud
              cleanup may remain pending if you are offline.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void confirmDelete()}
                className="rounded-2xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-rose-300"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
