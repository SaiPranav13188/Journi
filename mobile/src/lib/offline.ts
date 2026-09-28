// Offline trip pack: saves a trip's itinerary, bookings, ticket files, a map
// picture and the packing list on the phone so they work with no internet.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';

import { api } from './api';
import type { Booking, TripPlan } from './types';

export interface OfflineMap {
  file: string; // local uri
  width: number;
  height: number;
  /** Bounds of the picture (plain lat/lng projection, so pins map linearly). */
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface OfflinePack {
  tripId: string;
  savedAt: string;
  plan: TripPlan;
  bookings: (Booking & { local_ticket?: string | null })[];
  map: OfflineMap | null;
}

const indexKey = 'journi:offline:index';
const packKey = (id: string) => `journi:offline:${id}`;
const dirFor = (id: string) => new Directory(Paths.document, 'offline', id);

function ensureDir(dir: Directory) {
  if (!dir.exists) dir.create({ intermediates: true });
}

/** Static map picture covering all pinned places (Esri, no key needed). */
async function downloadMap(plan: TripPlan, dir: Directory): Promise<OfflineMap | null> {
  const pts = plan.days.flatMap((d) => d.activities.filter((a) => !a.placeholder && a.lat != null && a.lng != null).map((a) => [a.lat!, a.lng!]));
  if (!pts.length) return null;
  const width = 800;
  const height = 560;
  let minLat = Math.min(...pts.map((p) => p[0]));
  let maxLat = Math.max(...pts.map((p) => p[0]));
  let minLng = Math.min(...pts.map((p) => p[1]));
  let maxLng = Math.max(...pts.map((p) => p[1]));
  // Pad 15% and match the picture's aspect ratio so pins line up exactly.
  let latSpan = Math.max(maxLat - minLat, 0.01) * 1.3;
  let lngSpan = Math.max(maxLng - minLng, 0.01) * 1.3;
  if (lngSpan / latSpan > width / height) latSpan = (lngSpan * height) / width;
  else lngSpan = (latSpan * width) / height;
  const cLat = (minLat + maxLat) / 2;
  const cLng = (minLng + maxLng) / 2;
  minLat = cLat - latSpan / 2;
  maxLat = cLat + latSpan / 2;
  minLng = cLng - lngSpan / 2;
  maxLng = cLng + lngSpan / 2;

  const url =
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/export?' +
    `bbox=${minLng},${minLat},${maxLng},${maxLat}&bboxSR=4326&imageSR=4326&size=${width},${height}&format=png&f=image`;
  const target = new File(dir, 'map.png');
  if (target.exists) target.delete();
  const file = await File.downloadFileAsync(url, target);
  return { file: file.uri, width, height, minLat, maxLat, minLng, maxLng };
}

/** Downloads (or refreshes) the offline pack for a saved trip. Needs internet. */
export async function saveOfflinePack(tripId: string): Promise<OfflinePack> {
  const [plan, bookings] = await Promise.all([api.getTrip(tripId), api.bookings(tripId).catch(() => [] as Booking[])]);
  const dir = dirFor(tripId);
  ensureDir(dir);

  let map: OfflineMap | null = null;
  try {
    map = await downloadMap(plan, dir);
  } catch {
    map = null; // the rest of the pack still works
  }

  const withTickets = await Promise.all(
    bookings.map(async (b) => {
      if (!b.ticket_path) return { ...b, local_ticket: null };
      try {
        const { url } = await api.ticketUrl(b.id);
        const ext = b.ticket_path.split('.').pop() || 'pdf';
        const target = new File(dir, `ticket-${b.id}.${ext}`);
        if (target.exists) target.delete();
        const file = await File.downloadFileAsync(url, target);
        return { ...b, local_ticket: file.uri };
      } catch {
        return { ...b, local_ticket: null };
      }
    }),
  );

  const pack: OfflinePack = { tripId, savedAt: new Date().toISOString(), plan, bookings: withTickets, map };
  await AsyncStorage.setItem(packKey(tripId), JSON.stringify(pack));
  const index = await listOfflineTripIds();
  if (!index.includes(tripId)) await AsyncStorage.setItem(indexKey, JSON.stringify([...index, tripId]));
  return pack;
}

export async function loadOfflinePack(tripId: string): Promise<OfflinePack | null> {
  try {
    const raw = await AsyncStorage.getItem(packKey(tripId));
    return raw ? (JSON.parse(raw) as OfflinePack) : null;
  } catch {
    return null;
  }
}

export async function removeOfflinePack(tripId: string): Promise<void> {
  const dir = dirFor(tripId);
  if (dir.exists) dir.delete();
  await AsyncStorage.removeItem(packKey(tripId));
  const index = await listOfflineTripIds();
  await AsyncStorage.setItem(indexKey, JSON.stringify(index.filter((id) => id !== tripId)));
}

export async function listOfflineTripIds(): Promise<string[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(indexKey)) || '[]');
  } catch {
    return [];
  }
}
