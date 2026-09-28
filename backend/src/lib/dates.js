// Date helpers that work purely on calendar dates (YYYY-MM-DD) in UTC, so a
// trip's day boundaries never shift with the server's timezone.

export function parseIsoDate(value) {
  if (value instanceof Date) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toIsoDate(date) {
  return parseIsoDate(date).toISOString().slice(0, 10);
}

export function addDays(date, days) {
  const d = parseIsoDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function daysBetweenInclusive(start, end) {
  const ms = parseIsoDate(end) - parseIsoDate(start);
  return Math.round(ms / 86_400_000) + 1;
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function isValidIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseIsoDate(value).getTime());
}
