import type { ChangeEvent, RefObject } from 'react';

export interface VaultToolbarProps {
  disabled: boolean;
  importing: boolean;
  settingsOpen: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPickFiles: () => void;
  onFilesChosen: (event: ChangeEvent<HTMLInputElement>) => void;
  onPasteImport: () => void;
  onRefresh: () => void;
  onToggleSettings: () => void;
}

export function VaultToolbar({
  disabled,
  importing,
  settingsOpen,
  fileInputRef,
  onPickFiles,
  onFilesChosen,
  onPasteImport,
  onRefresh,
  onToggleSettings,
}: VaultToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={onFilesChosen}
      />
      <button
        type="button"
        disabled={disabled || importing}
        onClick={onPickFiles}
        className="inline-flex items-center justify-center rounded-2xl bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-cyan-300"
      >
        {importing ? 'Importing…' : 'Add files'}
      </button>
      <button
        type="button"
        disabled={disabled || importing}
        onClick={onPasteImport}
        className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-cyan-300 hover:text-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Paste files
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onRefresh}
        className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-cyan-300 hover:text-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Refresh
      </button>
      <button
        type="button"
        aria-pressed={settingsOpen}
        onClick={onToggleSettings}
        className={`inline-flex items-center justify-center rounded-2xl border px-4 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-cyan-300 focus:ring-offset-2 ${
          settingsOpen
            ? 'border-cyan-300 bg-cyan-50 text-cyan-800'
            : 'border-slate-200 bg-white text-slate-700 hover:border-cyan-300 hover:text-cyan-700'
        }`}
      >
        Vault settings
      </button>
      <p className="w-full text-xs text-slate-500 sm:ml-auto sm:w-auto">
        Drag files in, or copy files in the OS and paste here.
      </p>
    </div>
  );
}
