import { StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';

/** Share-into is native-only; web has no system share target. */
export default function HandleShareScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Share not available</Text>
      <Text style={styles.body}>
        Receiving shared text and links requires the iOS or Android app.
      </Text>
    </View>
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
});
