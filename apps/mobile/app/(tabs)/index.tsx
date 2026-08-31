import { StyleSheet } from 'react-native';

import { VaultBrowser } from '@/components/vault/VaultBrowser';
import { View } from '@/components/Themed';

export default function VaultScreen() {
  return (
    <View style={styles.container}>
      <VaultBrowser />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
