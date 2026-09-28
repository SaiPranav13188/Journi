import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, LinearTransition } from 'react-native-reanimated';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { Colors, Radius, Shadow } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';

type Mode = 'signin' | 'signup';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function EmailAuthScreen() {
  const insets = useSafeAreaInsets();
  const { signInWithEmail, signUpWithEmail } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string; form?: string }>({});
  const [loading, setLoading] = useState(false);
  const [confirmSentTo, setConfirmSentTo] = useState<string | null>(null);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  const validate = () => {
    const next: typeof errors = {};
    if (mode === 'signup' && name.trim().length < 2) next.name = 'Please enter your name';
    if (!EMAIL_RE.test(email.trim())) next.email = 'Enter a valid email address';
    if (password.length < (mode === 'signup' ? 8 : 1)) {
      next.password = mode === 'signup' ? 'Use at least 8 characters' : 'Enter your password';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      if (mode === 'signin') {
        await signInWithEmail(email, password);
      } else {
        const needsConfirmation = await signUpWithEmail(name, email, password);
        if (needsConfirmation) setConfirmSentTo(email.trim());
      }
    } catch (err) {
      const message = (err as Error).message;
      setErrors({
        form: /invalid login credentials/i.test(message)
          ? 'That email and password don’t match. Try again or create an account.'
          : /email not confirmed/i.test(message)
            ? 'Please confirm your email first — check your inbox for the link.'
            : message,
      });
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setErrors({});
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: Colors.bg }} behavior="padding">
      <StatusBar style="light" />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 24 }} bounces={false}>
        <View style={styles.header}>
          <Image source={require('@/assets/images/onboarding/kyoto.jpg')} style={StyleSheet.absoluteFill} contentFit="cover" />
          <LinearGradient colors={['rgba(8,16,28,0.2)', 'rgba(8,16,28,0.75)']} style={StyleSheet.absoluteFill} />
          <View style={[styles.headerContent, { paddingTop: insets.top + 8 }]}>
            <IconButton icon="chevron-back" variant="glass" onPress={() => router.back()} accessibilityLabel="Back" />
            <Animated.View entering={FadeInDown.duration(500)} style={{ marginTop: 'auto' }}>
              <Text variant="h1" color={Colors.white}>
                {mode === 'signin' ? 'Welcome back' : 'Start your journey'}
              </Text>
              <Text variant="body" color="rgba(255,255,255,0.85)" style={{ marginTop: 4 }}>
                {mode === 'signin' ? 'Sign in to pick up where you left off.' : 'Create an account to save and sync your trips.'}
              </Text>
            </Animated.View>
          </View>
        </View>

        <Animated.View entering={FadeInDown.delay(100).duration(500)} layout={LinearTransition} style={styles.card}>
          {confirmSentTo ? (
            <Animated.View entering={FadeIn} style={{ alignItems: 'center', gap: 12, paddingVertical: 12 }}>
              <View style={styles.mailIcon}>
                <Ionicons name="mail-open-outline" size={30} color={Colors.primary} />
              </View>
              <Text variant="h3" center>
                Check your inbox
              </Text>
              <Text variant="body" color={Colors.inkSoft} center>
                We sent a confirmation link to <Text variant="bodyStrong">{confirmSentTo}</Text>. Tap it, then come back and sign in.
              </Text>
              <Button
                title="Back to sign in"
                variant="secondary"
                onPress={() => {
                  setConfirmSentTo(null);
                  switchMode('signin');
                }}
                style={{ marginTop: 8 }}
              />
            </Animated.View>
          ) : (
            <>
              <View style={styles.segment}>
                {(['signin', 'signup'] as Mode[]).map((m) => (
                  <PressableScale key={m} onPress={() => switchMode(m)} style={[styles.segmentItem, mode === m && styles.segmentActive]}>
                    <Text variant="label" color={mode === m ? Colors.ink : Colors.muted}>
                      {m === 'signin' ? 'Sign in' : 'Create account'}
                    </Text>
                  </PressableScale>
                ))}
              </View>

              {mode === 'signup' && (
                <Animated.View entering={FadeInDown.duration(250)} exiting={FadeOut.duration(150)}>
                  <TextField
                    label="Your name"
                    icon="person-outline"
                    placeholder="Priya Sharma"
                    value={name}
                    onChangeText={setName}
                    autoComplete="name"
                    returnKeyType="next"
                    onSubmitEditing={() => emailRef.current?.focus()}
                    error={errors.name}
                  />
                </Animated.View>
              )}
              <TextField
                ref={emailRef}
                label="Email"
                icon="mail-outline"
                placeholder="you@example.com"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                returnKeyType="next"
                onSubmitEditing={() => passwordRef.current?.focus()}
                error={errors.email}
              />
              <TextField
                ref={passwordRef}
                label="Password"
                icon="lock-closed-outline"
                placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'}
                value={password}
                onChangeText={setPassword}
                secureToggle
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                returnKeyType="go"
                onSubmitEditing={submit}
                error={errors.password}
              />

              {!!errors.form && (
                <Animated.View entering={FadeIn} style={styles.formError}>
                  <Ionicons name="alert-circle" size={18} color={Colors.danger} />
                  <Text variant="caption" color={Colors.danger} style={{ flex: 1 }}>
                    {errors.form}
                  </Text>
                </Animated.View>
              )}

              <Button
                title={mode === 'signin' ? 'Sign in' : 'Create account'}
                size="lg"
                onPress={submit}
                loading={loading}
                iconRight="arrow-forward"
                style={{ marginTop: 6 }}
              />
            </>
          )}
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: { height: 280, overflow: 'hidden' },
  headerContent: { flex: 1, paddingHorizontal: 20, paddingBottom: 48 },
  card: {
    marginTop: -28,
    marginHorizontal: 16,
    padding: 20,
    gap: 16,
    borderRadius: Radius.xxl,
    backgroundColor: Colors.surface,
    ...Shadow.raised,
  },
  segment: { flexDirection: 'row', backgroundColor: Colors.surfaceAlt, borderRadius: Radius.pill, padding: 4 },
  segmentItem: { flex: 1, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.pill },
  segmentActive: { backgroundColor: Colors.surface, ...Shadow.card },
  formError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: Radius.md,
    backgroundColor: Colors.dangerSoft,
  },
  mailIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
