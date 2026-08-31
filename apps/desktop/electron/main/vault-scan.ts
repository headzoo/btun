import type {
  DirectChildSnapshot,
  ExpectedLocalEffect,
  LocalVaultEvent,
  PlatformFileIdentity,
} from '@yard-1/vault';

export interface ScannedChild extends DirectChildSnapshot {
  fingerprintKey: string;
}

export function fingerprintKey(
  child: Pick<DirectChildSnapshot, 'size' | 'mtimeMs'> & {
    sha256?: string;
  },
): string {
  if (child.sha256) {
    return `sha:${child.sha256}:${child.size}`;
  }
  return `mt:${child.size}:${Math.trunc(child.mtimeMs)}`;
}

export function identityKey(identity: { dev?: string; ino?: string } | undefined): string | null {
  if (!identity?.dev || !identity.ino) {
    return null;
  }
  return `${identity.dev}:${identity.ino}`;
}

export function toPlatformIdentity(child: ScannedChild): PlatformFileIdentity {
  const identity: PlatformFileIdentity = {
    size: child.size,
    mtimeMs: child.mtimeMs,
  };
  if (child.identity?.dev) {
    identity.dev = child.identity.dev;
  }
  if (child.identity?.ino) {
    identity.ino = child.identity.ino;
  }
  return identity;
}

/**
 * Diff two direct-child snapshots. Prefer rename pairing by (dev,ino), then by a
 * unique unchanged fingerprint. Ambiguous matches degrade to delete+create.
 */
export function diffVaultSnapshots(
  previous: ReadonlyMap<string, ScannedChild>,
  next: ReadonlyMap<string, ScannedChild>,
): LocalVaultEvent[] {
  const events: LocalVaultEvent[] = [];
  const previousNames = new Set(previous.keys());
  const nextNames = new Set(next.keys());

  const removed: ScannedChild[] = [];
  const added: ScannedChild[] = [];

  for (const name of previousNames) {
    if (!nextNames.has(name)) {
      const child = previous.get(name);
      if (child) {
        removed.push(child);
      }
    }
  }
  for (const name of nextNames) {
    if (!previousNames.has(name)) {
      const child = next.get(name);
      if (child) {
        added.push(child);
      }
    }
  }

  const unpairedRemoved = new Set(removed.map((child) => child.name));
  const unpairedAdded = new Set(added.map((child) => child.name));

  const removedByIdentity = new Map<string, ScannedChild>();
  for (const child of removed) {
    const key = identityKey(child.identity);
    if (!key) {
      continue;
    }
    if (removedByIdentity.has(key)) {
      removedByIdentity.delete(key);
    } else {
      removedByIdentity.set(key, child);
    }
  }

  for (const child of added) {
    const key = identityKey(child.identity);
    if (!key) {
      continue;
    }
    const match = removedByIdentity.get(key);
    if (!match) {
      continue;
    }
    events.push({ type: 'renamed', from: match.name, to: child.name });
    unpairedRemoved.delete(match.name);
    unpairedAdded.delete(child.name);
    removedByIdentity.delete(key);
  }

  const removedByFingerprint = new Map<string, ScannedChild[]>();
  for (const name of unpairedRemoved) {
    const child = previous.get(name);
    if (!child) {
      continue;
    }
    const list = removedByFingerprint.get(child.fingerprintKey) ?? [];
    list.push(child);
    removedByFingerprint.set(child.fingerprintKey, list);
  }

  for (const name of [...unpairedAdded]) {
    const child = next.get(name);
    if (!child) {
      continue;
    }
    const candidates = removedByFingerprint.get(child.fingerprintKey);
    if (!candidates || candidates.length !== 1) {
      continue;
    }
    const match = candidates[0];
    if (!match || !unpairedRemoved.has(match.name)) {
      continue;
    }
    events.push({ type: 'renamed', from: match.name, to: child.name });
    unpairedRemoved.delete(match.name);
    unpairedAdded.delete(child.name);
    removedByFingerprint.set(child.fingerprintKey, []);
  }

  for (const name of unpairedRemoved) {
    events.push({ type: 'deleted', name });
  }
  for (const name of unpairedAdded) {
    events.push({ type: 'created', name });
  }

  for (const name of nextNames) {
    if (!previousNames.has(name)) {
      continue;
    }
    const before = previous.get(name);
    const after = next.get(name);
    if (!before || !after) {
      continue;
    }
    if (
      before.size !== after.size ||
      Math.trunc(before.mtimeMs) !== Math.trunc(after.mtimeMs) ||
      identityKey(before.identity) !== identityKey(after.identity)
    ) {
      events.push({ type: 'changed', name });
    }
  }

  return events;
}

function effectMatchesChild(effect: ExpectedLocalEffect, child: ScannedChild | undefined): boolean {
  if (!child) {
    return false;
  }
  if (effect.name !== undefined && effect.name !== child.name) {
    return false;
  }
  if (effect.sha256 !== undefined) {
    // Only suppress when the scanned fingerprint includes the registered hash.
    // Never fall back to size alone — that swallows the next same-size user edit.
    return child.fingerprintKey.includes(effect.sha256);
  }
  if (effect.size !== undefined && effect.size !== child.size) {
    return false;
  }
  return true;
}

/**
 * Consume expected local effects produced by cloud-applied mutations so they do
 * not echo outward as user edits. Only exact matching events are suppressed.
 */
export function filterExpectedEffects(
  events: LocalVaultEvent[],
  expected: ExpectedLocalEffect[],
  next: ReadonlyMap<string, ScannedChild>,
): { events: LocalVaultEvent[]; remaining: ExpectedLocalEffect[] } {
  const remaining = [...expected];
  const kept: LocalVaultEvent[] = [];

  for (const event of events) {
    let suppressed = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const effect = remaining[i];
      if (!effect) {
        continue;
      }
      if (event.type === 'created' || event.type === 'changed') {
        if (effect.kind === 'write' && effectMatchesChild(effect, next.get(event.name))) {
          remaining.splice(i, 1);
          suppressed = true;
          break;
        }
      } else if (event.type === 'deleted') {
        if (effect.kind === 'delete' && (effect.name === undefined || effect.name === event.name)) {
          remaining.splice(i, 1);
          suppressed = true;
          break;
        }
      } else if (event.type === 'renamed') {
        if (
          effect.kind === 'rename' &&
          (effect.previousName === undefined || effect.previousName === event.from) &&
          (effect.name === undefined || effect.name === event.to)
        ) {
          remaining.splice(i, 1);
          suppressed = true;
          break;
        }
      }
    }
    if (!suppressed) {
      kept.push(event);
    }
  }

  return { events: kept, remaining };
}
