// INR <-> local currency rates. Frankfurter (ECB data, free, no key) first;
// it only covers ~30 currencies, so we fall back to open.er-api.com
// (exchangerate-api.com's free endpoint) for everything else.

import { config } from '../config.js';
import { TtlCache } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';

const cache = new TtlCache({ ttlMs: config.cacheTtlMs.exchange, maxEntries: 500 });

async function fromFrankfurter(target) {
  const body = await fetchJson(
    `https://api.frankfurter.dev/v1/latest?${new URLSearchParams({ base: 'INR', symbols: target })}`,
    { timeoutMs: 8000 },
  );
  const rate = body?.rates?.[target];
  if (!rate) return null;
  return {
    rate,
    // Frankfurter publishes one rate per working day (~16:00 CET).
    timestamp: new Date(`${body.date}T16:00:00+01:00`).toISOString(),
    provider: 'Frankfurter (European Central Bank)',
  };
}

async function fromOpenErApi(target) {
  const body = await fetchJson('https://open.er-api.com/v6/latest/INR', { timeoutMs: 8000 });
  const rate = body?.rates?.[target];
  if (body?.result !== 'success' || !rate) return null;
  return {
    rate,
    timestamp: new Date(body.time_last_update_unix * 1000).toISOString(),
    provider: 'ExchangeRate-API',
  };
}

/**
 * Returns { base: 'INR', target, rate, timestamp, provider } where
 * `rate` = units of target currency per 1 INR, or null if unavailable.
 */
export async function getInrRate(target) {
  if (!target || target === 'INR') return null;
  try {
    return await cache.wrap(`INR:${target}`, async () => {
      let result = null;
      try {
        result = await fromFrankfurter(target);
      } catch (err) {
        if (err.status !== 404 && err.status !== 422) console.warn('[currency] Frankfurter failed:', err.message);
      }
      if (!result) result = await fromOpenErApi(target);
      if (!result) throw new Error(`No exchange rate available for ${target}`);
      return { base: 'INR', target, ...result };
    });
  } catch (err) {
    console.warn('[currency]', err.message);
    return null;
  }
}
