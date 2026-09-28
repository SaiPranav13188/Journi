import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { Colors, Radius } from '@/constants/theme';
import { PressableScale } from './ui/pressable-scale';
import { Text } from './ui/text';

export interface PickedTicket {
  base64: string;
  mimeType: string;
  name: string;
}

const MAX_BYTES = 10 * 1024 * 1024;

/** What to call the document for each booking type. */
export const TICKET_LABEL: Record<string, string> = {
  flight: 'flight ticket or boarding pass',
  hotel: 'hotel confirmation',
  train: 'train ticket',
  bus: 'bus ticket',
  activity: 'activity or tour ticket',
  car: 'car rental confirmation',
  other: 'booking confirmation',
};

interface TicketUploadProps {
  type: string;
  /** Called with the chosen file; should read it and fill the form. */
  onPicked: (file: PickedTicket) => Promise<void>;
  attachedName?: string | null;
  onViewAttached?: () => void;
}

function Pulse() {
  const o = useSharedValue(0.4);
  useEffect(() => {
    o.set(withRepeat(withTiming(1, { duration: 700 }), -1, true));
  }, [o]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <Animated.View style={style}>
      <Ionicons name="sparkles" size={20} color={Colors.primary} />
    </Animated.View>
  );
}

/** "Upload your ticket" card: camera, photo library or PDF → auto-fill. */
export function TicketUpload({ type, onPicked, attachedName, onViewAttached }: TicketUploadProps) {
  const [busy, setBusy] = useState(false);
  const label = TICKET_LABEL[type] ?? TICKET_LABEL.other;

  const handle = async (file: PickedTicket | null) => {
    if (!file) return;
    setBusy(true);
    try {
      await onPicked(file);
    } catch (err) {
      Alert.alert('Couldn’t read the ticket', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fromCamera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera access needed', 'Allow camera access in Settings to photograph your ticket.');
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7, base64: true });
    const a = res.canceled ? null : res.assets[0];
    await handle(a?.base64 ? { base64: a.base64, mimeType: a.mimeType ?? 'image/jpeg', name: a.fileName ?? 'ticket-photo.jpg' } : null);
  };

  const fromLibrary = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7, base64: true });
    const a = res.canceled ? null : res.assets[0];
    await handle(a?.base64 ? { base64: a.base64, mimeType: a.mimeType ?? 'image/jpeg', name: a.fileName ?? 'ticket.jpg' } : null);
  };

  const fromFiles = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/*'], copyToCacheDirectory: true });
    if (res.canceled) return;
    const a = res.assets[0];
    if (a.size && a.size > MAX_BYTES) {
      Alert.alert('File too large', 'Please choose a file under 10 MB, or take a photo of the ticket instead.');
      return;
    }
    setBusy(true);
    try {
      const base64 = await new File(a.uri).base64();
      setBusy(false);
      await handle({ base64, mimeType: a.mimeType ?? 'application/pdf', name: a.name });
    } catch (err) {
      setBusy(false);
      Alert.alert('Couldn’t open the file', (err as Error).message);
    }
  };

  return (
    <View style={styles.card}>
      {busy ? (
        <Animated.View entering={FadeIn} style={styles.busy}>
          <Pulse />
          <View style={{ flex: 1 }}>
            <Text variant="label">Reading your {label}…</Text>
            <Text variant="caption" color={Colors.muted}>
              Filling in the details for you — a few seconds
            </Text>
          </View>
          <ActivityIndicator color={Colors.primary} />
        </Animated.View>
      ) : (
        <>
          <View style={styles.head}>
            <View style={styles.icon}>
              <Ionicons name="scan-outline" size={22} color={Colors.white} />
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="label">{attachedName ? 'Ticket attached' : `Upload your ${label}`}</Text>
              <Text variant="caption" color={Colors.muted}>
                {attachedName ? 'Upload another to re-fill the details' : 'We’ll fill in everything for you — no typing'}
              </Text>
            </View>
          </View>
          {attachedName && (
            <PressableScale haptic onPress={onViewAttached} disabled={!onViewAttached} style={styles.attached}>
              <Ionicons name="document-attach-outline" size={16} color={Colors.success} />
              <Text variant="caption" color={Colors.success} numberOfLines={1} style={{ flex: 1 }}>
                {attachedName}
              </Text>
              {onViewAttached && (
                <Text variant="label" color={Colors.primary} style={{ fontSize: 12 }}>
                  View
                </Text>
              )}
            </PressableScale>
          )}
          <View style={styles.buttons}>
            {(
              [
                { key: 'camera', label: 'Take photo', icon: 'camera-outline', onPress: fromCamera },
                { key: 'library', label: 'Photos', icon: 'images-outline', onPress: fromLibrary },
                { key: 'file', label: 'PDF / file', icon: 'document-text-outline', onPress: fromFiles },
              ] as const
            ).map((b) => (
              <PressableScale key={b.key} haptic onPress={b.onPress} style={styles.btn}>
                <Ionicons name={b.icon} size={20} color={Colors.primary} />
                <Text variant="caption" color={Colors.primaryDark} style={{ fontSize: 12 }}>
                  {b.label}
                </Text>
              </PressableScale>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 12,
    padding: 14,
    borderRadius: Radius.xl,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: Colors.primary,
    backgroundColor: Colors.primarySoft,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 42, height: 42, borderRadius: 12, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  buttons: { flexDirection: 'row', gap: 8 },
  btn: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 10, borderRadius: Radius.md, backgroundColor: Colors.surface },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  attached: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: Radius.md, backgroundColor: Colors.successSoft },
});
