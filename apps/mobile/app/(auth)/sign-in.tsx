import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import {
  formatAuthError,
  isFirebaseInitialized,
  signInWithEmail,
  signUpWithEmail,
} from '@yard-1/firebase';

import { Text, View, useThemeColor } from '@/components/Themed';
import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';

type Mode = 'sign-in' | 'sign-up';

export default function SignInScreen() {
  const colorScheme = useColorScheme();
  const textColor = useThemeColor({}, 'text');
  const backgroundColor = useThemeColor({}, 'background');
  const tint = Colors[colorScheme].tint;

  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isFirebaseInitialized()) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Firebase not configured</Text>
        <Text style={styles.body}>
          Copy apps/mobile/.env.example to .env.local and set your EXPO_PUBLIC_FIREBASE_* values,
          then restart Expo. Enable Email/Password in the Firebase Console.
        </Text>
      </View>
    );
  }

  async function onSubmit() {
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError('Email and password are required.');
      return;
    }

    if (mode === 'sign-up') {
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
      if (password.length < 6) {
        setError('Password should be at least 6 characters.');
        return;
      }
    }

    setSubmitting(true);
    try {
      if (mode === 'sign-in') {
        await signInWithEmail(trimmedEmail, password);
      } else {
        await signUpWithEmail(trimmedEmail, password);
      }
    } catch (err) {
      setError(formatAuthError(err));
    } finally {
      setSubmitting(false);
    }
  }

  function toggleMode() {
    setError(null);
    setConfirmPassword('');
    setMode((current) => (current === 'sign-in' ? 'sign-up' : 'sign-in'));
  }

  const inputStyle = [
    styles.input,
    {
      color: textColor,
      borderColor: colorScheme === 'dark' ? 'rgba(255,255,255,0.2)' : '#ddd',
      backgroundColor: colorScheme === 'dark' ? 'rgba(255,255,255,0.06)' : '#fafafa',
    },
  ];

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.container}>
        <Text style={styles.title}>{mode === 'sign-in' ? 'Sign in' : 'Create account'}</Text>
        <Text style={styles.subtitle}>
          {mode === 'sign-in'
            ? 'Sign in with your email and password to continue.'
            : 'Create an account to use Buddy Tunnel.'}
        </Text>

        <TextInput
          style={inputStyle}
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          placeholderTextColor={colorScheme === 'dark' ? '#888' : '#999'}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          autoComplete="email"
          editable={!submitting}
        />
        <TextInput
          style={inputStyle}
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          placeholderTextColor={colorScheme === 'dark' ? '#888' : '#999'}
          secureTextEntry
          textContentType={mode === 'sign-up' ? 'newPassword' : 'password'}
          autoComplete={mode === 'sign-up' ? 'new-password' : 'password'}
          editable={!submitting}
        />
        {mode === 'sign-up' ? (
          <TextInput
            style={inputStyle}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            placeholder="Confirm password"
            placeholderTextColor={colorScheme === 'dark' ? '#888' : '#999'}
            secureTextEntry
            textContentType="newPassword"
            autoComplete="new-password"
            editable={!submitting}
          />
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={[styles.button, { backgroundColor: tint, opacity: submitting ? 0.7 : 1 }]}
          onPress={onSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText} lightColor="#fff" darkColor="#000">
              {mode === 'sign-in' ? 'Sign in' : 'Create account'}
            </Text>
          )}
        </Pressable>

        <Pressable onPress={toggleMode} disabled={submitting} style={styles.toggle}>
          <Text style={styles.toggleText}>
            {mode === 'sign-in'
              ? "Don't have an account? Create one"
              : 'Already have an account? Sign in'}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    opacity: 0.7,
    marginBottom: 12,
  },
  body: {
    textAlign: 'center',
    lineHeight: 22,
    opacity: 0.8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  button: {
    marginTop: 8,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: '#dc2626',
    fontSize: 14,
    lineHeight: 20,
  },
  toggle: {
    marginTop: 8,
    alignItems: 'center',
    paddingVertical: 8,
  },
  toggleText: {
    fontSize: 14,
    opacity: 0.8,
  },
});
