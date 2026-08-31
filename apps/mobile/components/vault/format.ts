/** Human-readable byte size for vault list rows. */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) {
    return '—';
  }
  if (size < 1000) {
    return `${size} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1000;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

/** Short local date/time for vault list rows. */
export function formatVaultDate(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) {
    return '—';
  }
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function fileTypeLabel(mimeType: string, localName: string): string {
  if (mimeType && mimeType !== 'application/octet-stream') {
    const [type, subtype] = mimeType.split('/');
    if (type && subtype) {
      return subtype.toUpperCase();
    }
    if (type) {
      return type.toUpperCase();
    }
  }
  const dot = localName.lastIndexOf('.');
  if (dot > 0 && dot < localName.length - 1) {
    return localName.slice(dot + 1).toUpperCase();
  }
  return 'FILE';
}
