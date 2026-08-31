import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Redirect, Stack, ThemeProvider, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import 'react-native-reanimated';
import { isFirebaseInitialized, useAuth } from '@yard-1/firebase';

import { Text, View } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { ensureFirebase } from '@/lib/firebase';
import { hasPendingSharedPayloads } from '@/lib/pendingShare';
import { useVault } from '@/hooks/useVault';

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

// Initialize Firebase as early as possible (no-op if env vars are missing).
ensureFirebase();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });
  const { loading: authLoading } = useAuth();

  // Expo Router uses Error Boundaries to catch errors in the navigation tree.
  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded && !authLoading) {
      SplashScreen.hideAsync();
    }
  }, [loaded, authLoading]);

  if (!loaded || authLoading) {
    return null;
  }

  return <RootLayoutNav />;
}

function AuthenticatedVaultSync() {
  useVault();
  return null;
}

function RootLayoutNav() {
  const colorScheme = useColorScheme();
  const { user } = useAuth();
  const segments = useSegments();
  const configured = isFirebaseInitialized();

  if (!configured) {
    return (
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <View style={styles.configContainer}>
          <Text style={styles.configTitle}>Firebase not configured</Text>
          <Text style={styles.configBody}>
            Copy apps/mobile/.env.example to .env.local and set your EXPO_PUBLIC_FIREBASE_* values,
            then restart Expo. Enable Email/Password sign-in in the Firebase Console.
          </Text>
        </View>
      </ThemeProvider>
    );
  }

  const inAuthGroup = segments[0] === '(auth)';
  const inShareHandler = segments[0] === 'handle-share';
  const hasPendingShare = hasPendingSharedPayloads();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {user ? <AuthenticatedVaultSync /> : null}
      <Stack>
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="handle-share" options={{ title: 'Share to Buddy Tunnel' }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal' }} />
      </Stack>
      {!user && !inAuthGroup && !inShareHandler ? <Redirect href="/sign-in" /> : null}
      {user && inAuthGroup ? <Redirect href={hasPendingShare ? '/handle-share' : '/'} /> : null}
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  configContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  configTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 12,
    textAlign: 'center',
  },
  configBody: {
    textAlign: 'center',
    lineHeight: 22,
    opacity: 0.8,
  },
});
