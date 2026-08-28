import { Link, router, Stack } from 'expo-router';
import { useIncomingShare } from 'expo-sharing';
import type { SharePayload } from 'expo-sharing';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { MAX_STORAGE_MESSAGE_LENGTH, saveStorageItem, useAuth } from '@yard-1/firebase';

import { Text, View } from '@/components/Themed';
import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';

function messageFromPayloads(payloads: SharePayload[]): string | null {
  const parts = payloads
    .filter((p) => p.shareType === 'text' || p.shareType === 'url')
    .map((p) => p.value.trim())
    .filter((value) => value.length > 0);

  if (parts.length === 0) {
    return null;
  }

  return parts.join('\n').slice(0, MAX_STORAGE_MESSAGE_LENGTH);
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function HandleShareScreen() {
  const colorScheme = useColorScheme();
  const tint = Colors[colorScheme].tint;
  const { user } = useAuth();
  const {
    sharedPayloads,
    isResolving,
    error: resolveError,
    clearSharedPayloads,
  } = useIncomingShare();

  const message = useMemo(() => messageFromPayloads(sharedPayloads), [sharedPayloads]);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedPreview, setSavedPreview] = useState<string | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!user || !message || savingRef.current || saveState === 'saved') {
      return;
    }

    let cancelled = false;
    savingRef.current = true;
    setSaveState('saving');
    setSaveError(null);

    void (async () => {
      try {
        await saveStorageItem(user.uid, message);
        if (cancelled) {
          return;
        }
        setSavedPreview(message);
        clearSharedPayloads();
        setSaveState('saved');
      } catch (err) {
        if (cancelled) {
          return;
        }
        savingRef.current = false;
        setSaveState('error');
        setSaveError(err instanceof Error ? err.message : 'Failed to save shared content.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, message, saveState, clearSharedPayloads]);

  useEffect(() => {
    if (saveState !== 'saved') {
      return;
    }
    const timer = setTimeout(() => {
      router.replace('/');
    }, 1200);
    return () => clearTimeout(timer);
  }, [saveState]);

  return (
    <>
      <Stack.Screen options={{ title: 'Share to Buddy Tunnel' }} />
      <View style={styles.container}>
        {saveState === 'saved' ? (
          <>
            <Text style={styles.title}>Saved</Text>
            <Text style={styles.body}>Shared content was added to your storage.</Text>
            {savedPreview ? (
              <Text style={styles.preview} numberOfLines={4}>
                {savedPreview}
              </Text>
            ) : null}
          </>
        ) : isResolving && !message ? (
          <>
            <ActivityIndicator size="large" color={tint} />
            <Text style={styles.body}>Reading shared content…</Text>
          </>
        ) : resolveError && !message ? (
          <>
            <Text style={styles.title}>Could not read share</Text>
            <Text style={styles.body}>{resolveError.message}</Text>
            <Pressable onPress={() => router.replace('/')} style={styles.button}>
              <Text style={[styles.buttonLabel, { color: tint }]}>Go home</Text>
            </Pressable>
          </>
        ) : !message ? (
          <>
            <Text style={styles.title}>Nothing to save</Text>
            <Text style={styles.body}>
              Buddy Tunnel accepts shared text and links. Try sharing again from another app.
            </Text>
            <Pressable onPress={() => router.replace('/')} style={styles.button}>
              <Text style={[styles.buttonLabel, { color: tint }]}>Go home</Text>
            </Pressable>
          </>
        ) : !user ? (
          <>
            <Text style={styles.title}>Sign in to save</Text>
            <Text style={styles.preview} numberOfLines={6}>
              {message}
            </Text>
            <Text style={styles.body}>
              Sign in so this share can be saved to your Buddy Tunnel storage.
            </Text>
            <Link href="/sign-in" asChild>
              <Pressable style={styles.button}>
                <Text style={[styles.buttonLabel, { color: tint }]}>Sign in</Text>
              </Pressable>
            </Link>
          </>
        ) : saveState === 'error' ? (
          <>
            <Text style={styles.title}>Save failed</Text>
            <Text style={styles.body}>{saveError ?? 'Unknown error'}</Text>
            <Pressable
              onPress={() => {
                savingRef.current = false;
                setSaveState('idle');
                setSaveError(null);
              }}
              style={styles.button}
            >
              <Text style={[styles.buttonLabel, { color: tint }]}>Retry</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                clearSharedPayloads();
                router.replace('/');
              }}
              style={styles.button}
            >
              <Text style={[styles.buttonLabel, { color: tint }]}>Dismiss</Text>
            </Pressable>
          </>
        ) : (
          <>
            <ActivityIndicator size="large" color={tint} />
            <Text style={styles.body}>Saving to Buddy Tunnel…</Text>
            <Text style={styles.preview} numberOfLines={4}>
              {message}
            </Text>
          </>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
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
    lineHeight: 22,
    opacity: 0.7,
    marginVertical: 8,
    maxWidth: '100%',
  },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  buttonLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
});
