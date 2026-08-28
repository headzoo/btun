import { StyleSheet } from 'react-native';
import { isFirebaseInitialized, useRealtimeValue } from '@yard-1/firebase';

import { Text, View } from '@/components/Themed';

const STATUS_PATH = 'status';

export default function FirebaseScreen() {
  const configured = isFirebaseInitialized();
  const { data, loading, error } = useRealtimeValue<string | Record<string, unknown>>(STATUS_PATH);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Firebase RTDB</Text>
      <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />

      {!configured ? (
        <Text style={styles.body}>
          Firebase is not configured. Copy apps/mobile/.env.example to .env.local and set your
          EXPO_PUBLIC_FIREBASE_* values, then restart Expo.
        </Text>
      ) : loading ? (
        <Text style={styles.body}>Listening to /{STATUS_PATH}…</Text>
      ) : error ? (
        <Text style={styles.body}>Error: {error.message}</Text>
      ) : (
        <Text style={styles.body}>
          /{STATUS_PATH}:{'\n'}
          {data === null
            ? '(null — write a value in the Firebase console)'
            : JSON.stringify(data, null, 2)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  separator: {
    marginVertical: 30,
    height: 1,
    width: '80%',
  },
  body: {
    textAlign: 'center',
    lineHeight: 22,
  },
});
