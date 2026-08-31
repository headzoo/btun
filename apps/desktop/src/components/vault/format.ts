import type { FilenameIssue } from '@yard-1/vault';

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) {
    return '—';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function formatEntryDate(mtimeMs: number, updatedAt?: number): string {
  const ms = typeof updatedAt === 'number' && updatedAt > 0 ? updatedAt : mtimeMs;
  if (!Number.isFinite(ms) || ms <= 0) {
    return '—';
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

export function filenameIssueMessage(issue: FilenameIssue): string {
  switch (issue) {
    case 'empty':
      return 'Name cannot be empty.';
    case 'too-long':
      return 'Name is too long.';
    case 'dot-or-dotdot':
      return 'Name cannot be "." or "..".';
    case 'separator-or-illegal':
      return 'Name contains illegal characters.';
    case 'trailing-dot-or-space':
      return 'Name cannot end with a space or period.';
    case 'windows-reserved':
      return 'Name is reserved by the operating system.';
    case 'index-or-temp':
      return 'Name is reserved for Buddy Tunnel metadata.';
    default:
      return 'Invalid file name.';
  }
}

export function fileTypeLabel(mimeType: string, localName: string): string {
  if (mimeType.startsWith('text/')) {
    return 'Text';
  }
  if (mimeType.startsWith('image/')) {
    return 'Image';
  }
  if (mimeType.startsWith('audio/')) {
    return 'Audio';
  }
  if (mimeType.startsWith('video/')) {
    return 'Video';
  }
  if (mimeType === 'application/pdf') {
    return 'PDF';
  }
  const dot = localName.lastIndexOf('.');
  if (dot > 0 && dot < localName.length - 1) {
    return localName.slice(dot + 1).toUpperCase();
  }
  return 'File';
}
