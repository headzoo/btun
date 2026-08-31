import { useEffect, useId, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { uniquifyLocalName, validateLocalName, type FileEntry } from '@yard-1/vault';

import { fileTypeLabel, filenameIssueMessage, formatBytes, formatEntryDate } from './format';

export interface VaultRowProps {
  entry: FileEntry;
  occupiedNames: string[];
  caseSensitiveNames: boolean;
  busy: boolean;
  onOpen: (entry: FileEntry) => void;
  onRename: (entry: FileEntry, nextName: string) => Promise<void>;
  onDelete: (entry: FileEntry) => void;
  onReveal: (entry: FileEntry) => void;
  onDragOut: (entry: FileEntry) => void;
}

function statusLabel(entry: FileEntry): string | null {
  switch (entry.status) {
    case 'pending':
      return 'Pending sync';
    case 'error':
      return entry.errorMessage ?? 'Sync error';
    case 'missing':
      return 'Missing on disk';
    default:
      return null;
  }
}

export function VaultRow({
  entry,
  occupiedNames,
  caseSensitiveNames,
  busy,
  onOpen,
  onRename,
  onDelete,
  onReveal,
  onDragOut,
}: VaultRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(entry.localName);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const canOpen = entry.status === 'ready' || entry.status === 'pending';
  const canDrag = entry.status === 'ready';
  const status = statusLabel(entry);
  const draftValidation = validateLocalName(draft.trim());
  let collisionPreview: string | null = null;
  if (draftValidation.ok) {
    const others = occupiedNames.filter((name) => name !== entry.localName);
    const unique = uniquifyLocalName(draftValidation.name, others, {
      caseSensitive: caseSensitiveNames,
    });
    if (unique !== draftValidation.name) {
      collisionPreview = `Local name will be ${unique} to avoid a collision on this device.`;
    }
  }

  useEffect(() => {
    if (!renaming) {
      setDraft(entry.localName);
      setRenameError(null);
    }
  }, [entry.localName, renaming]);

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  async function commitRename() {
    const validated = validateLocalName(draft.trim());
    if (!validated.ok) {
      setRenameError(filenameIssueMessage(validated.issue));
      return;
    }
    if (validated.name === entry.localName) {
      setRenaming(false);
      setRenameError(null);
      return;
    }
    setSaving(true);
    setRenameError(null);
    try {
      await onRename(entry, validated.name);
      setRenaming(false);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : 'Rename failed.');
    } finally {
      setSaving(false);
    }
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (renaming) {
      return;
    }
    if (event.key === 'Enter' && canOpen) {
      event.preventDefault();
      onOpen(entry);
    }
  }

  function onDragStart(event: DragEvent<HTMLDivElement>) {
    if (!canDrag || busy) {
      event.preventDefault();
      return;
    }
    // Native Electron drag-out is owned by main via startDrag; cancel DOM drag payload.
    event.preventDefault();
    onDragOut(entry);
  }

  return (
    <div
      role="row"
      tabIndex={0}
      aria-labelledby={nameId}
      data-vault-id={entry.id}
      data-vault-status={entry.status}
      draggable={canDrag && !renaming && !busy}
      onDragStart={onDragStart}
      onDoubleClick={() => {
        if (!renaming && canOpen) {
          onOpen(entry);
        }
      }}
      onKeyDown={onRowKeyDown}
      className={`group grid grid-cols-[minmax(0,1.6fr)_7rem_9rem_minmax(7rem,0.7fr)_auto] items-center gap-3 border-b border-slate-100 px-4 py-3 outline-none transition last:border-b-0 focus-visible:bg-cyan-50/70 ${
        entry.status === 'error' || entry.status === 'missing'
          ? 'bg-rose-50/40'
          : 'hover:bg-slate-50/80'
      }`}
    >
      <div className="min-w-0">
        {renaming ? (
          <form
            className="space-y-1"
            onSubmit={(event) => {
              event.preventDefault();
              void commitRename();
            }}
          >
            <label className="sr-only" htmlFor={nameId}>
              Rename file
            </label>
            <input
              id={nameId}
              ref={inputRef}
              value={draft}
              disabled={saving || busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setRenaming(false);
                  setDraft(entry.localName);
                  setRenameError(null);
                }
              }}
              className="w-full rounded-xl border border-cyan-300 bg-white px-3 py-1.5 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-cyan-300"
            />
            {renameError ? <p className="text-xs text-rose-700">{renameError}</p> : null}
            {!draftValidation.ok ? (
              <p className="text-xs text-rose-700">{filenameIssueMessage(draftValidation.issue)}</p>
            ) : null}
            {draftValidation.ok && collisionPreview ? (
              <p className="text-xs text-amber-700">{collisionPreview}</p>
            ) : null}
            {entry.preferredName && entry.preferredName !== entry.localName ? (
              <p className="text-xs text-slate-500">
                Sync preferred name stays “{entry.preferredName}”; this device keeps its local name.
              </p>
            ) : null}
            <p className="text-xs text-slate-500">
              Renames this device&apos;s file and syncs the preferred name. Escape to cancel.
            </p>
          </form>
        ) : (
          <>
            <div id={nameId} className="truncate text-sm font-medium text-slate-900">
              {entry.localName}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>{fileTypeLabel(entry.mimeType, entry.localName)}</span>
              {status ? (
                <span className={entry.status === 'pending' ? 'text-amber-700' : 'text-rose-700'}>
                  {status}
                </span>
              ) : null}
            </div>
          </>
        )}
      </div>

      <div className="text-sm tabular-nums text-slate-600">{formatBytes(entry.size)}</div>
      <div className="truncate text-sm text-slate-600">
        {formatEntryDate(entry.mtimeMs, entry.updatedAt)}
      </div>
      <div className="text-xs uppercase tracking-[0.18em] text-slate-400">
        {entry.status === 'ready' ? 'Ready' : entry.status}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-1">
        {renaming ? (
          <>
            <button
              type="button"
              disabled={saving || busy}
              onClick={() => void commitRename()}
              className="rounded-xl bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-700 disabled:cursor-not-allowed disabled:bg-cyan-300"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setRenaming(false);
                setDraft(entry.localName);
                setRenameError(null);
              }}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-300"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={!canOpen || busy}
              onClick={() => onOpen(entry)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-cyan-300 hover:text-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Open
            </button>
            <button
              type="button"
              disabled={busy || entry.status === 'missing'}
              onClick={() => {
                setDraft(entry.localName);
                setRenameError(null);
                setRenaming(true);
              }}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-cyan-300 hover:text-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Rename
            </button>
            <button
              type="button"
              disabled={busy || entry.status === 'missing'}
              onClick={() => onReveal(entry)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-cyan-300 hover:text-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Reveal
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onDelete(entry)}
              className="rounded-xl border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 hover:border-rose-300 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}
