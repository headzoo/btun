import { Link, router, Stack } from 'expo-router';
import { useIncomingShare } from 'expo-sharing';
import type { ResolvedSharePayload, SharePayload } from 'expo-sharing';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useAuth } from '@yard-1/firebase';

import { Text, View } from '@/components/Themed';
import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { useVault } from '@/hooks/useVault';
import {
  beginShareOperation,
  completeShareOperation,
  failShareOperation,
  isShareOperationComplete,
  preferredNameForSharePayload,
  resetShareOperationGuards,
  sharePayloadIdentity,
} from '@/lib/pendingShare';
import { importTextAsVaultFile, importUriIntoVault } from '@/lib/vault/mobileImports';
import { getMobileVaultAdapter } from '@/lib/vault/mobileVaultAdapter';
import { isNativeVaultPlatform } from '@/lib/vault/mobileVaultSettings';

type ItemStatus = 'queued' | 'importing' | 'success' | 'error' | 'dismissed';

interface ShareItemState {
  key: string;
  payload: SharePayload;
  resolved?: ResolvedSharePayload;
  index: number;
  preferredName: string;
  status: ItemStatus;
  error?: string;
  localName?: string;
}

function isMediaOrFile(shareType: SharePayload['shareType']): boolean {
  return (
    shareType === 'file' || shareType === 'image' || shareType === 'video' || shareType === 'audio'
  );
}

async function importOnePayload(item: ShareItemState): Promise<{ localName: string }> {
  const adapter = getMobileVaultAdapter();
  if (item.payload.shareType === 'text' || item.payload.shareType === 'url') {
    // Full text/URL preserved; sync classifier chooses inline vs blob.
    const result = await importTextAsVaultFile(adapter, item.payload.value, item.preferredName);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return { localName: result.value.name };
  }
  if (isMediaOrFile(item.payload.shareType)) {
    const uri =
      item.resolved && 'contentUri' in item.resolved && item.resolved.contentUri
        ? item.resolved.contentUri
        : item.payload.value;
    const result = await importUriIntoVault(adapter, uri, item.preferredName);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return { localName: result.value.localName };
  }
  throw new Error(`Unsupported share type: ${item.payload.shareType}`);
}

export default function HandleShareScreen() {
  const colorScheme = useColorScheme();
  const tint = Colors[colorScheme].tint;
  const { user } = useAuth();
  const vault = useVault();
  const {
    sharedPayloads,
    resolvedSharedPayloads,
    isResolving,
    error: resolveError,
    clearSharedPayloads,
  } = useIncomingShare();

  const [items, setItems] = useState<ShareItemState[]>([]);
  const finishingRef = useRef(false);

  const vaultReady =
    Boolean(user) &&
    isNativeVaultPlatform() &&
    vault.rootStatus.kind === 'ready' &&
    !vault.initialLoading;

  useEffect(() => {
    if (sharedPayloads.length === 0) {
      return;
    }
    setItems((prev) => {
      const byKey = new Map(prev.map((item) => [item.key, item]));
      return sharedPayloads.map((payload, index) => {
        const key = sharePayloadIdentity(payload, index);
        const resolved = resolvedSharedPayloads[index];
        const originalName = resolved && 'originalName' in resolved ? resolved.originalName : null;
        const preferredName = preferredNameForSharePayload(payload, index, originalName);
        const existing = byKey.get(key);
        if (existing) {
          return {
            ...existing,
            resolved: resolved ?? existing.resolved,
            preferredName: existing.preferredName || preferredName,
          };
        }
        if (isShareOperationComplete(key)) {
          return {
            key,
            payload,
            resolved,
            index,
            preferredName,
            status: 'success' as const,
          };
        }
        return {
          key,
          payload,
          resolved,
          index,
          preferredName,
          status: 'queued' as const,
        };
      });
    });
  }, [sharedPayloads, resolvedSharedPayloads]);

  const updateItem = useCallback((key: string, patch: Partial<ShareItemState>) => {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }, []);

  const importItem = useCallback(
    async (item: ShareItemState) => {
      if (!vaultReady) {
        return;
      }
      if (!beginShareOperation(item.key)) {
        if (isShareOperationComplete(item.key)) {
          updateItem(item.key, { status: 'success' });
        }
        return;
      }
      updateItem(item.key, { status: 'importing', error: undefined });
      try {
        const result = await importOnePayload(item);
        completeShareOperation(item.key);
        updateItem(item.key, { status: 'success', localName: result.localName, error: undefined });
        try {
          await vault.commands.refresh();
        } catch {
          // Local write already durable; refresh is best-effort for list visibility.
        }
      } catch (error) {
        failShareOperation(item.key);
        updateItem(item.key, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Import failed.',
        });
      }
    },
    [updateItem, vault.commands, vaultReady],
  );

  useEffect(() => {
    if (!user || !vaultReady || items.length === 0) {
      return;
    }
    for (const item of items) {
      if (item.status === 'queued') {
        void importItem(item);
      }
    }
  }, [user, vaultReady, items, importItem]);

  const summary = useMemo(() => {
    const active = items.filter((item) => item.status !== 'dismissed');
    return {
      total: active.length,
      success: active.filter((item) => item.status === 'success').length,
      failed: active.filter((item) => item.status === 'error').length,
      pending: active.filter((item) => item.status === 'queued' || item.status === 'importing')
        .length,
      allTerminal:
        active.length > 0 &&
        active.every((item) => item.status === 'success' || item.status === 'error'),
      allSuccess: active.length > 0 && active.every((item) => item.status === 'success'),
    };
  }, [items]);

  const filesVisible = useMemo(() => {
    const names = new Set(
      items
        .filter((item) => item.status === 'success' && item.localName)
        .map((item) => item.localName as string),
    );
    if (names.size === 0) {
      return summary.allSuccess;
    }
    const present = new Set(vault.entries.map((entry) => entry.localName));
    for (const name of names) {
      if (!present.has(name)) {
        return false;
      }
    }
    return true;
  }, [items, vault.entries, summary.allSuccess]);

  const finishAndGoHome = useCallback(async () => {
    if (finishingRef.current) {
      return;
    }
    finishingRef.current = true;
    try {
      clearSharedPayloads();
      resetShareOperationGuards();
      router.replace('/');
    } finally {
      finishingRef.current = false;
    }
  }, [clearSharedPayloads]);

  useEffect(() => {
    if (!summary.allSuccess) {
      return;
    }
    if (!filesVisible && summary.success > 0) {
      return;
    }
    const timer = setTimeout(() => {
      void finishAndGoHome();
    }, 900);
    return () => clearTimeout(timer);
  }, [summary.allSuccess, summary.success, filesVisible, finishAndGoHome]);

  const dismissFailed = useCallback(
    (key: string) => {
      failShareOperation(key);
      updateItem(key, { status: 'dismissed' });
    },
    [updateItem],
  );

  const dismissAllFailedAndFinish = useCallback(() => {
    setItems((prev) => {
      const next = prev.map((item) => {
        if (item.status === 'error') {
          failShareOperation(item.key);
          return { ...item, status: 'dismissed' as const };
        }
        return item;
      });
      const remaining = next.filter((item) => item.status !== 'dismissed');
      if (remaining.length === 0 || remaining.every((item) => item.status === 'success')) {
        queueMicrotask(() => {
          void finishAndGoHome();
        });
      }
      return next;
    });
  }, [finishAndGoHome]);

  useEffect(() => {
    const remaining = items.filter((item) => item.status !== 'dismissed');
    const hadDismissed = items.some((item) => item.status === 'dismissed');
    if (!hadDismissed) {
      return;
    }
    if (remaining.length === 0) {
      void finishAndGoHome();
      return;
    }
    if (remaining.every((item) => item.status === 'success') && filesVisible) {
      void finishAndGoHome();
    }
  }, [items, filesVisible, finishAndGoHome]);

  const previewLabel = (item: ShareItemState): string => {
    if (item.payload.shareType === 'text') {
      return item.payload.value.slice(0, 120);
    }
    if (item.payload.shareType === 'url') {
      return item.payload.value;
    }
    return item.preferredName;
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Share to Buddy Tunnel' }} />
      <ScrollView contentContainerStyle={styles.container}>
        {!isNativeVaultPlatform() ? (
          <>
            <Text style={styles.title}>Native only</Text>
            <Text style={styles.body}>Incoming shares require the iOS or Android app.</Text>
          </>
        ) : isResolving && sharedPayloads.length === 0 ? (
          <>
            <ActivityIndicator size="large" color={tint} />
            <Text style={styles.body}>Reading shared content…</Text>
          </>
        ) : resolveError && sharedPayloads.length === 0 ? (
          <>
            <Text style={styles.title}>Could not read share</Text>
            <Text style={styles.body}>{resolveError.message}</Text>
            <Pressable onPress={() => router.replace('/')} style={styles.button}>
              <Text style={[styles.buttonLabel, { color: tint }]}>Go home</Text>
            </Pressable>
          </>
        ) : sharedPayloads.length === 0 && items.length === 0 ? (
          <>
            <Text style={styles.title}>Nothing to save</Text>
            <Text style={styles.body}>
              Buddy Tunnel accepts shared files, photos, video, audio, text, and links.
            </Text>
            <Pressable onPress={() => router.replace('/')} style={styles.button}>
              <Text style={[styles.buttonLabel, { color: tint }]}>Go home</Text>
            </Pressable>
          </>
        ) : !user ? (
          <>
            <Text style={styles.title}>Sign in to save</Text>
            <Text style={styles.body}>
              {sharedPayloads.length} shared item{sharedPayloads.length === 1 ? '' : 's'} will
              import into your vault after you sign in. Content stays pending until then.
            </Text>
            {sharedPayloads.slice(0, 5).map((payload, index) => (
              <Text
                key={sharePayloadIdentity(payload, index)}
                style={styles.preview}
                numberOfLines={2}
              >
                {preferredNameForSharePayload(payload, index)}
              </Text>
            ))}
            <Link href="/sign-in" asChild>
              <Pressable style={styles.button}>
                <Text style={[styles.buttonLabel, { color: tint }]}>Sign in</Text>
              </Pressable>
            </Link>
          </>
        ) : !vaultReady ? (
          <>
            <ActivityIndicator size="large" color={tint} />
            <Text style={styles.body}>
              {vault.rootStatus.kind === 'permission' || vault.rootStatus.kind === 'error'
                ? vault.rootStatus.message
                : vault.rootStatus.kind === 'owner-mismatch'
                  ? vault.rootStatus.message
                  : 'Preparing your vault…'}
            </Text>
            {(vault.rootStatus.kind === 'permission' ||
              vault.rootStatus.kind === 'error' ||
              vault.rootStatus.kind === 'owner-mismatch') && (
              <Pressable
                onPress={() => {
                  clearSharedPayloads();
                  resetShareOperationGuards();
                  router.replace('/two');
                }}
                style={styles.button}
              >
                <Text style={[styles.buttonLabel, { color: tint }]}>Open settings</Text>
              </Pressable>
            )}
          </>
        ) : (
          <>
            <Text style={styles.title}>
              {summary.allSuccess
                ? 'Saved'
                : summary.pending > 0
                  ? 'Importing…'
                  : summary.failed > 0
                    ? 'Import finished with errors'
                    : 'Importing…'}
            </Text>
            <Text style={styles.body}>
              {summary.success}/{summary.total} saved
              {summary.failed > 0 ? ` · ${summary.failed} failed` : ''}
              {summary.pending > 0 ? ` · ${summary.pending} in progress` : ''}
            </Text>
            {items
              .filter((item) => item.status !== 'dismissed')
              .map((item) => (
                <View key={item.key} style={styles.card}>
                  <Text style={styles.cardTitle} numberOfLines={1}>
                    {item.preferredName}
                  </Text>
                  <Text style={styles.preview} numberOfLines={3}>
                    {previewLabel(item)}
                  </Text>
                  <Text style={styles.meta}>
                    {item.status === 'queued' && 'Waiting…'}
                    {item.status === 'importing' && 'Saving to vault…'}
                    {item.status === 'success' &&
                      `Saved as ${item.localName ?? item.preferredName}`}
                    {item.status === 'error' && (item.error ?? 'Failed')}
                  </Text>
                  {item.status === 'error' ? (
                    <View style={styles.rowActions}>
                      <Pressable
                        onPress={() => {
                          void importItem(item);
                        }}
                        style={styles.button}
                      >
                        <Text style={[styles.buttonLabel, { color: tint }]}>Retry</Text>
                      </Pressable>
                      <Pressable onPress={() => dismissFailed(item.key)} style={styles.button}>
                        <Text style={styles.buttonLabel}>Dismiss</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              ))}
            {summary.failed > 0 && summary.pending === 0 ? (
              <Pressable onPress={dismissAllFailedAndFinish} style={styles.button}>
                <Text style={[styles.buttonLabel, { color: tint }]}>
                  Dismiss failures and continue
                </Text>
              </Pressable>
            ) : null}
            {summary.allTerminal && summary.failed > 0 ? (
              <Pressable
                onPress={() => {
                  clearSharedPayloads();
                  resetShareOperationGuards();
                  router.replace('/');
                }}
                style={styles.button}
              >
                <Text style={styles.buttonLabel}>Cancel and clear share</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 24,
    gap: 12,
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
  preview: {
    textAlign: 'center',
    lineHeight: 20,
    opacity: 0.7,
    maxWidth: '100%',
  },
  meta: {
    textAlign: 'center',
    fontSize: 13,
    opacity: 0.8,
  },
  card: {
    width: '100%',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(127,127,127,0.4)',
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  rowActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'transparent',
  },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  buttonLabel: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
});
