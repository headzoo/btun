import { SymbolView } from 'expo-symbols';
import { Link, Tabs } from 'expo-router';
import { Pressable, Text } from 'react-native';
import { signOutUser } from '@yard-1/firebase';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { useClientOnlyValue } from '@/components/useClientOnlyValue';

export default function TabLayout() {
  const colorScheme = useColorScheme();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme].tint,
        // Disable the static render of the header on web
        // to prevent a hydration error in React Navigation v6.
        headerShown: useClientOnlyValue(false, true),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Tab One',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{
                ios: 'chevron.left.forwardslash.chevron.right',
                android: 'code',
                web: 'code',
              }}
              tintColor={color}
              size={28}
            />
          ),
          headerRight: () => (
            <Link href="/modal" asChild>
              <Pressable style={{ marginRight: 15 }}>
                {({ pressed }) => (
                  <SymbolView
                    name={{ ios: 'info.circle', android: 'info', web: 'info' }}
                    size={25}
                    tintColor={Colors[colorScheme].text}
                    style={{ opacity: pressed ? 0.5 : 1 }}
                  />
                )}
              </Pressable>
            </Link>
          ),
        }}
      />
      <Tabs.Screen
        name="two"
        options={{
          title: 'Tab Two',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{
                ios: 'chevron.left.forwardslash.chevron.right',
                android: 'code',
                web: 'code',
              }}
              tintColor={color}
              size={28}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="firebase"
        options={{
          title: 'Firebase',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{
                ios: 'flame',
                android: 'local_fire_department',
                web: 'local_fire_department',
              }}
              tintColor={color}
              size={28}
            />
          ),
          headerRight: () => (
            <Pressable
              onPress={() => {
                void signOutUser();
              }}
              style={{ marginRight: 15 }}
            >
              {({ pressed }) => (
                <Text
                  style={{
                    color: Colors[colorScheme].tint,
                    fontSize: 16,
                    opacity: pressed ? 0.5 : 1,
                  }}
                >
                  Sign out
                </Text>
              )}
            </Pressable>
          ),
        }}
      />
    </Tabs>
  );
}
