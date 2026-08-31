import { StyleSheet } from 'react-native';

import { VaultSettingsPanel } from '@/components/vault/VaultSettingsPanel';
import { View } from '@/components/Themed';

/** Settings tab (route name `two` retained for Expo typed-routes stability). */
export default function SettingsScreen() {
  return (
    <View style={styles.container}>
      <VaultSettingsPanel />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
