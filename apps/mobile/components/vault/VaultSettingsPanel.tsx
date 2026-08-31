import { useCallback, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet } from 'react-native';
import { signOutUser, useAuth } from '@yard-1/firebase';

import { Text, View } from '@/components/Themed';
import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { getMobileVaultAdapter } from '@/lib/vault/mobileVaultAdapter';
import { isNativeVaultPlatform } from '@/lib/vault/mobileVaultSettings';
import { restartMobileVaultSync } from '@/lib/vaultSync';

export function VaultSettingsPanel() {
  const colorScheme = useColorScheme();
  const tint = Colors[colorScheme].tint;
  const { user } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const adapter = isNativeVaultPlatform() ? getMobileVaultAdapter() : null;
  const status = adapter?.getStatus() ?? null;

  const refreshMessage = useCallback((next: string | null, nextHint?: string | null) => {
    setMessage(next);
    setHint(nextHint ?? null);
  }, []);

  const onResetDefault = useCallback(async () => {
    if (!adapter) {
      return;
    }
    setBusy(true);
    refreshMessage(null);
    try {
      const result = await adapter.useDefaultRoot();
      if (!result.ok) {
        refreshMessage(result.error.message);
        return;
      }
      await restartMobileVaultSync();
      refreshMessage('Using the app Documents vault. The previous folder was left untouched.');
    } catch (error) {
      refreshMessage(error instanceof Error ? error.message : 'Failed to reset vault root.');
    } finally {
      setBusy(false);
    }
  }, [adapter, refreshMessage]);

  const onChooseDirectory = useCallback(async () => {
    if (!adapter) {
      return;
    }
    setBusy(true);
    refreshMessage(null);
    try {
      const result = await adapter.chooseSelectedRoot();
      if (!result.ok) {
        refreshMessage(result.error.message, result.importOnlyHint ?? null);
        return;
      }
      await restartMobileVaultSync();
      refreshMessage(
        `Vault root updated to “${result.value.rootDisplayName ?? 'selected folder'}”. Previous location left untouched.`,
      );
    } catch (error) {
      refreshMessage(error instanceof Error ? error.message : 'Directory selection failed.');
    } finally {
      setBusy(false);
    }
  }, [adapter, refreshMessage]);

  if (!isNativeVaultPlatform()) {
    return (
      <View style={styles.section}>
        <Text style={styles.heading}>Vault</Text>
        <Text style={styles.body}>
          Vault storage is available on iOS and Android. This web session only handles account
          access.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Vault location</Text>
      <Text style={styles.body}>
        Active root: {status?.rootDisplayName ?? status?.rootUri ?? 'App Documents / Buddy Tunnel'}
      </Text>
      <Text style={[styles.body, { opacity: 0.7 }]}>
        {status?.usingDefaultRoot
          ? 'Using the reliable app Documents default.'
          : 'Using a selected folder. Changing roots leaves the old folder untouched and materializes synced files into the new root.'}
      </Text>
      {status?.indexInAppDocuments ? (
        <Text style={[styles.body, { opacity: 0.7 }]}>
          Index is stored in app Documents because the selected folder cannot hold it safely.
        </Text>
      ) : null}

      {busy ? <ActivityIndicator color={tint} style={{ marginVertical: 8 }} /> : null}
      {message ? <Text style={styles.feedback}>{message}</Text> : null}
      {hint ? <Text style={[styles.feedback, { opacity: 0.75 }]}>{hint}</Text> : null}

      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => {
          void onResetDefault();
        }}
        style={styles.button}
      >
        <Text style={[styles.buttonLabel, { color: tint }]}>Reset to app Documents</Text>
      </Pressable>
      {Platform.OS === 'android' ? (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => {
            void onChooseDirectory();
          }}
          style={styles.button}
        >
          <Text style={[styles.buttonLabel, { color: tint }]}>Choose directory…</Text>
        </Pressable>
      ) : (
        <Text style={[styles.body, { opacity: 0.65, fontSize: 13 }]}>
          iOS keeps the app Documents vault across restarts. Use Import to copy files from other
          locations; selected folders are not durable vault roots.
        </Text>
      )}
      <Text style={[styles.body, { opacity: 0.65, fontSize: 13 }]}>
        External folders are accepted only after a write/rename/delete capability probe and when
        access can persist. Read-only locations stay import sources via the document picker. Old
        roots are left untouched when you change location.
      </Text>

      <View style={styles.separator} />
      <Text style={styles.heading}>Account</Text>
      <Text style={styles.body}>{user?.email ?? 'Signed in'}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void signOutUser();
        }}
        style={styles.button}
      >
        <Text style={[styles.buttonLabel, { color: tint }]}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    flex: 1,
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 10,
  },
  heading: {
    fontSize: 18,
    fontWeight: '700',
    marginTop: 8,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
  },
  feedback: {
    fontSize: 14,
    lineHeight: 20,
    color: '#2f95dc',
  },
  button: {
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  buttonLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(127,127,127,0.35)',
    marginVertical: 12,
  },
});
