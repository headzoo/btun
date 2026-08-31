import { Pressable, StyleSheet } from 'react-native';

import type { FileEntry } from '@yard-1/vault';

import { Text, View, useThemeColor } from '@/components/Themed';
import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';

import { fileTypeLabel, formatBytes, formatVaultDate } from './format';

export interface VaultFileRowProps {
  entry: FileEntry;
  onOpen: (entry: FileEntry) => void;
  onRename: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
}

export function VaultFileRow({ entry, onOpen, onRename, onDelete }: VaultFileRowProps) {
  const colorScheme = useColorScheme();
  const tint = Colors[colorScheme].tint;
  const muted = useThemeColor({}, 'text');
  const border = colorScheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';
  const ready = entry.status === 'ready';
  const statusLabel =
    entry.status === 'pending'
      ? 'Syncing…'
      : entry.status === 'error'
        ? (entry.errorMessage ?? 'Error')
        : entry.status === 'missing'
          ? 'Missing'
          : null;

  return (
    <View style={[styles.row, { borderBottomColor: border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${entry.localName}`}
        accessibilityState={{ disabled: !ready }}
        disabled={!ready}
        onPress={() => onOpen(entry)}
        style={({ pressed }) => [styles.main, { opacity: pressed ? 0.7 : 1 }]}
      >
        <View style={styles.titleRow}>
          <Text style={styles.name} numberOfLines={1}>
            {entry.localName}
          </Text>
          <Text style={[styles.badge, { color: muted, opacity: 0.55 }]}>
            {fileTypeLabel(entry.mimeType, entry.localName)}
          </Text>
        </View>
        <Text style={[styles.meta, { opacity: 0.65 }]} numberOfLines={1}>
          {formatBytes(entry.size)} · {formatVaultDate(entry.mtimeMs || entry.updatedAt)}
        </Text>
        {statusLabel ? (
          <Text
            style={[
              styles.status,
              { color: entry.status === 'error' || entry.status === 'missing' ? '#c0392b' : tint },
            ]}
            numberOfLines={2}
          >
            {statusLabel}
          </Text>
        ) : null}
      </Pressable>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Rename ${entry.localName}`}
          onPress={() => onRename(entry)}
          style={styles.actionHit}
        >
          <Text style={[styles.actionLabel, { color: tint }]}>Rename</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete ${entry.localName}`}
          onPress={() => onDelete(entry)}
          style={styles.actionHit}
        >
          <Text style={[styles.actionLabel, { color: '#c0392b' }]}>Delete</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 8,
  },
  main: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  name: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
  },
  badge: {
    fontSize: 11,
    fontWeight: '600',
  },
  meta: {
    fontSize: 13,
  },
  status: {
    fontSize: 12,
    marginTop: 2,
  },
  actions: {
    justifyContent: 'center',
    gap: 4,
  },
  actionHit: {
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  actionLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
});
