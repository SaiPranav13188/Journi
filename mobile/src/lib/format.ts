// Formatting helpers. Dates are calendar dates (YYYY-MM-DD) handled in UTC so
// they never shift with the device timezone.

export function parseDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toIsoDate(date: Date): string {
  // From a local-time Date (e.g. a date picker) to its calendar date.
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function fromIsoToLocal(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDaysLocal(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function daysBetweenInclusive(startIso: string, endIso: string): number {
  return Math.round((parseDate(endIso).getTime() - parseDate(startIso).getTime()) / 86_400_000) + 1;
}

export function formatDate(iso: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }): string {
  return parseDate(iso).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
}

export function formatDateRange(startIso: string, endIso: string): string {
  const s = parseDate(startIso);
  const e = parseDate(endIso);
  const sameYear = s.getUTCFullYear() === e.getUTCFullYear();
  const sameMonth = sameYear && s.getUTCMonth() === e.getUTCMonth();
  if (sameMonth) return `${s.getUTCDate()}–${formatDate(endIso, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  if (sameYear) return `${formatDate(startIso)} – ${formatDate(endIso, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return `${formatDate(startIso, { day: 'numeric', month: 'short', year: 'numeric' })} – ${formatDate(endIso, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

export function weekday(iso: string): string {
  return formatDate(iso, { weekday: 'short' });
}

export function daysUntil(iso: string): number {
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((parseDate(iso).getTime() - today) / 86_400_000);
}

export function formatMoney(amount: number | null | undefined, currency: string, opts: { compact?: boolean } = {}): string {
  if (amount == null || Number.isNaN(amount)) return '—';
  const zeroDecimal = ['INR', 'JPY', 'KRW', 'VND', 'IDR', 'CLP', 'HUF', 'ISK', 'TWD', 'UGX', 'PYG'].includes(currency);
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency,
      notation: opts.compact && amount >= 100_000 ? 'compact' : 'standard',
      maximumFractionDigits: zeroDecimal || amount >= 1000 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString()}`;
  }
}

export function formatRate(rate: number): string {
  if (rate >= 100) return rate.toFixed(1);
  if (rate >= 1) return rate.toFixed(3);
  return rate.toPrecision(3);
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export function flagEmoji(countryCode?: string | null): string {
  if (!countryCode || countryCode.length !== 2) return '🌍';
  return String.fromCodePoint(...[...countryCode.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)));
}
