import type { DragEvent, ReactNode } from 'react';
import type { FileEntry } from '@yard-1/vault';

import { VaultRow } from './VaultRow';

export interface VaultListProps {
  entries: FileEntry[];
  initialLoading: boolean;
  syncStatusLabel: string;
  dropActive: boolean;
  busy: boolean;
  caseSensitiveNames: boolean;
  banner: ReactNode;
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onOpen: (entry: FileEntry) => void;
  onRename: (entry: FileEntry, nextName: string) => Promise<void>;
  onDelete: (entry: FileEntry) => void;
  onReveal: (entry: FileEntry) => void;
  onDragOut: (entry: FileEntry) => void;
}

export function VaultList({
  entries,
  initialLoading,
  syncStatusLabel,
  dropActive,
  busy,
  caseSensitiveNames,
  banner,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onOpen,
  onRename,
  onDelete,
  onReveal,
  onDragOut,
}: VaultListProps) {
  const occupiedNames = entries.map((entry) => entry.localName);
  return (
    <section
      aria-label="Vault files"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`overflow-hidden rounded-[1.75rem] border bg-white/95 shadow-[0_24px_70px_-40px_rgba(14,116,144,0.35)] transition ${dropActive
          ? 'border-cyan-400 ring-2 ring-cyan-300 ring-offset-2 ring-offset-slate-50'
          : 'border-slate-200'
        }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Buddy Tunnel</h1>
          <p className="mt-1 text-sm text-slate-500">Flat local vault · {syncStatusLabel}</p>
        </div>
        {banner}
      </div>

      <div role="table" aria-rowcount={entries.length} className="min-h-[18rem]">
        <div
          role="row"
          className="grid grid-cols-[minmax(0,1.6fr)_7rem_9rem_minmax(7rem,0.7fr)_auto] gap-3 border-b border-slate-100 bg-slate-50/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500"
        >
          <div role="columnheader">Name</div>
          <div role="columnheader">Size</div>
          <div role="columnheader">Updated</div>
          <div role="columnheader">State</div>
          <div role="columnheader" className="text-right">
            Actions
          </div>
        </div>

        {initialLoading ? (
          <div className="px-5 py-16 text-center text-sm text-slate-500">Loading vault…</div>
        ) : entries.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <p className="text-base font-medium text-slate-800">No files yet</p>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              Add files with the toolbar, paste from the OS clipboard, or drop files here.
            </p>
          </div>
        ) : (
          entries.map((entry) => (
            <VaultRow
              key={entry.id}
              entry={entry}
              occupiedNames={occupiedNames}
              caseSensitiveNames={caseSensitiveNames}
              busy={busy}
              onOpen={onOpen}
              onRename={onRename}
              onDelete={onDelete}
              onReveal={onReveal}
              onDragOut={onDragOut}
            />
          ))
        )}
      </div>
    </section>
  );
}
