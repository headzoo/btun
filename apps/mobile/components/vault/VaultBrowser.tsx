import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
} from 'react-native';
import { File } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import type { FileEntry } from '@yard-1/vault';
import { sanitizePreferredName } from '@yard-1/vault';

import { Text, View, useThemeColor } from '@/components/Themed';
import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { useVault } from '@/hooks/useVault';
import { requestVaultRescan } from '@/lib/vault/mobileVaultEvents';
import { isNativeVaultPlatform } from '@/lib/vault/mobileVaultSettings';
import { openVaultFile } from '@/lib/vault/openVaultFile';

import { VaultFileRow } from './VaultFileRow';

export function VaultBrowser() {
  const colorScheme = useColorScheme();
  const tint = Colors[colorScheme].tint;
  const textColor = useThemeColor({}, 'text');
  const backgroundColor = useThemeColor({}, 'background');
  const { entries, initialLoading, bootstrapped, syncStatusLabel, rootStatus, commands } = useVault();

  const [refreshing, setRefreshing] = useState(false);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setActionError(null);
    try {
      await commands.refresh();
      requestVaultRescan('refresh');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Refresh failed.');
    } finally {
      setRefreshing(false);
    }
  }, [commands]);

  const onOpen = useCallback(async (entry: FileEntry) => {
    setActionError(null);
    const result = await openVaultFile(entry);
    if (!result.ok) {
      setActionError(result.error.message);
    }
  }, []);

  const onRename = useCallback((entry: FileEntry) => {
    setRenameTarget(entry);
    setRenameValue(entry.localName);
    setActionError(null);
  }, []);

  const submitRename = useCallback(async () => {
    if (!renameTarget) {
      return;
    }
    const preferred = sanitizePreferredName(renameValue.trim(), renameTarget.localName);
    if (!preferred || preferred === renameTarget.localName) {
      setRenameTarget(null);
      return;
    }
    setBusyMessage('Renaming…');
    try {
      await commands.rename(renameTarget.id, preferred);
      setRenameTarget(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Rename failed.');
    } finally {
      setBusyMessage(null);
    }
  }, [commands, renameTarget, renameValue]);

  const onDelete = useCallback(
    (entry: FileEntry) => {
      Alert.alert(
        'Delete file?',
        `Delete “${entry.localName}” from this device and every synced device? This cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                setBusyMessage('Deleting…');
                setActionError(null);
                try {
                  await commands.remove(entry.id);
                } catch (error) {
                  setActionError(error instanceof Error ? error.message : 'Delete failed.');
                } finally {
                  setBusyMessage(null);
                }
              })();
            },
          },
        ],
      );
    },
    [commands],
  );

  const onImport = useCallback(async () => {
    if (!isNativeVaultPlatform()) {
      setActionError('Document import requires iOS or Android.');
      return;
    }
    setActionError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
        type: '*/*',
      });
      if (result.canceled || !result.assets?.length) {
        return;
      }
      setBusyMessage(`Importing ${result.assets.length} file(s)…`);
      const failures: string[] = [];
      for (const asset of result.assets) {
        try {
          const bytes = await new File(asset.uri).bytes();
          const preferred = sanitizePreferredName(asset.name || 'file');
          await commands.importBytes(preferred, bytes);
        } catch (error) {
          failures.push(
            `${asset.name ?? 'file'}: ${error instanceof Error ? error.message : 'import failed'}`,
          );
        }
      }
      requestVaultRescan('picker');
      if (failures.length > 0) {
        setActionError(failures.join('\n'));
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Document picker failed.');
    } finally {
      setBusyMessage(null);
    }
  }, [commands]);

  if (!isNativeVaultPlatform()) {
    return (
      <View style={styles.centered}>
        <Text style={styles.title}>Vault is native-only</Text>
        <Text style={styles.body}>
          The Buddy Tunnel vault runs on iOS and Android development builds. Web can sign in but
          does not store local vault files.
        </Text>
      </View>
    );
  }

  if (rootStatus.kind === 'owner-mismatch') {
    return (
      <View style={styles.centered}>
        <Text style={styles.title}>Different account</Text>
        <Text style={styles.body}>
          {rootStatus.message ||
            'This vault folder belongs to another account. Choose a different folder in Settings or reset to app Documents.'}
        </Text>
      </View>
    );
  }

  if (rootStatus.kind === 'permission') {
    return (
      <View style={styles.centered}>
        <Text style={styles.title}>Vault unavailable</Text>
        <Text style={styles.body}>{rootStatus.message}</Text>
        <Text style={styles.body}>
          Open Settings to reset to the app Documents vault. The previous folder is left untouched.
        </Text>
      </View>
    );
  }

  if (rootStatus.kind === 'error') {
    return (
      <View style={styles.centered}>
        <Text style={styles.title}>Vault error</Text>
        <Text style={styles.body}>{rootStatus.message}</Text>
      </View>
    );
  }

  const showLoading = initialLoading || (!bootstrapped && rootStatus.kind !== 'ready');

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Import files"
          onPress={() => {
            void onImport();
          }}
          style={({ pressed }) => [styles.toolbarButton, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Text style={[styles.toolbarLabel, { color: tint }]}>Import</Text>
        </Pressable>
        <Text style={[styles.connectivity, { opacity: 0.65 }]}>{syncStatusLabel}</Text>
      </View>

      {actionError ? (
        <Pressable onPress={() => setActionError(null)} style={styles.banner}>
          <Text style={styles.bannerText}>{actionError}</Text>
        </Pressable>
      ) : null}

      {busyMessage ? (
        <View style={styles.busyRow}>
          <ActivityIndicator color={tint} />
          <Text style={styles.busyText}>{busyMessage}</Text>
        </View>
      ) : null}

      {showLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={tint} />
          <Text style={styles.body}>Loading vault…</Text>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <VaultFileRow
              entry={item}
              onOpen={(entry) => {
                void onOpen(entry);
              }}
              onRename={onRename}
              onDelete={onDelete}
            />
          )}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void onRefresh()}
              tintColor={tint}
            />
          }
          contentContainerStyle={entries.length === 0 ? styles.emptyList : undefined}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.title}>No files yet</Text>
              <Text style={styles.body}>
                Import a document or share a file, photo, link, or note into Buddy Tunnel.
              </Text>
              <Pressable
                onPress={() => {
                  void onImport();
                }}
                style={styles.emptyAction}
              >
                <Text style={[styles.toolbarLabel, { color: tint }]}>Import files</Text>
              </Pressable>
            </View>
          }
        />
      )}

      <Modal
        visible={renameTarget != null}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameTarget(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor }]}>
            <Text style={styles.title}>Rename</Text>
            <Text style={styles.body}>
              Local name on this device. Other devices keep their own names unless they sync a
              preferred rename.
            </Text>
            <TextInput
              value={renameValue}
              onChangeText={setRenameValue}
              autoFocus
              selectTextOnFocus
              style={[styles.input, { color: textColor, borderColor: tint }]}
              placeholder="Filename"
              placeholderTextColor={colorScheme === 'dark' ? '#888' : '#999'}
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setRenameTarget(null)} style={styles.modalButton}>
                <Text style={{ color: tint, fontWeight: '600' }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  void submitRename();
                }}
                style={styles.modalButton}
              >
                <Text style={{ color: tint, fontWeight: '600' }}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 12,
  },
  emptyList: {
    flexGrow: 1,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  body: {
    textAlign: 'center',
    lineHeight: 22,
    opacity: 0.85,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
  },
  toolbarButton: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  toolbarLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  connectivity: {
    fontSize: 12,
    flexShrink: 1,
    textAlign: 'right',
  },
  banner: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(192, 57, 43, 0.12)',
  },
  bannerText: {
    color: '#c0392b',
    fontSize: 13,
    lineHeight: 18,
  },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  busyText: {
    fontSize: 13,
    opacity: 0.8,
  },
  emptyAction: {
    marginTop: 8,
    padding: 8,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    borderRadius: 12,
    padding: 20,
    gap: 12,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 16,
  },
  modalButton: {
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
});
