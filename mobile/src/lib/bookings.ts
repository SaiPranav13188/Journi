import type { Ionicons } from '@expo/vector-icons';

import type { BookingStatus, BookingType } from './types';

export const BOOKING_TYPES: { key: BookingType; label: string; icon: keyof typeof Ionicons.glyphMap; color: string; titleHint: string }[] = [
  { key: 'flight', label: 'Flight', icon: 'airplane', color: '#0EA5E9', titleHint: 'e.g. Hyderabad → Hanoi (VJ 942)' },
  { key: 'hotel', label: 'Hotel', icon: 'bed', color: '#0E6E6B', titleHint: 'e.g. Hanoi La Siesta Hotel' },
  { key: 'train', label: 'Train', icon: 'train', color: '#6366F1', titleHint: 'e.g. Hanoi → Sapa sleeper' },
  { key: 'bus', label: 'Bus', icon: 'bus', color: '#8B5CF6', titleHint: 'e.g. Airport shuttle' },
  { key: 'activity', label: 'Activity', icon: 'ticket', color: '#F59E0B', titleHint: 'e.g. Ha Long Bay cruise' },
  { key: 'car', label: 'Car', icon: 'car', color: '#EF4444', titleHint: 'e.g. Rental car pickup' },
  { key: 'other', label: 'Other', icon: 'bookmark', color: '#64748B', titleHint: 'e.g. Travel insurance' },
];

export const bookingType = (t: BookingType) => BOOKING_TYPES.find((b) => b.key === t) ?? BOOKING_TYPES[BOOKING_TYPES.length - 1];

export const STATUS_META: Record<BookingStatus, { label: string; color: string; bg: string }> = {
  confirmed: { label: 'Confirmed', color: '#15803D', bg: '#E4F5EA' },
  pending: { label: 'Pending', color: '#B45309', bg: '#FFF4E0' },
  cancelled: { label: 'Cancelled', color: '#DC2626', bg: '#FDECEC' },
};

export function formatBookingTime(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
