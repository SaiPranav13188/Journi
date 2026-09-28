// Daily forecast from Open-Meteo (free, no key) + "bad weather" detection.
// Open-Meteo forecasts ~16 days ahead; days further out are marked
// unavailable and get filled in by the daily refresh job as the trip nears.

import { config } from '../config.js';
import { TtlCache } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { addDays, toIsoDate, todayIso } from '../lib/dates.js';

const cache = new TtlCache({ ttlMs: config.cacheTtlMs.weather, maxEntries: 2000 });

const FORECAST_HORIZON_DAYS = 15;

export const WEATHER_THRESHOLDS = {
  heavyRainProbability: 70, // %
  heavyRainMm: 15, // mm/day — heavy rain regardless of probability
  extremeHeatC: 38,
  extremeColdC: -5,
  highWindKmh: 50,
  highGustKmh: 70,
};

// WMO weather interpretation codes -> human label + icon key used by the app.
const WMO = {
  0: ['Clear sky', 'sunny'],
  1: ['Mainly clear', 'sunny'],
  2: ['Partly cloudy', 'partly-cloudy'],
  3: ['Overcast', 'cloudy'],
  45: ['Fog', 'fog'],
  48: ['Freezing fog', 'fog'],
  51: ['Light drizzle', 'drizzle'],
  53: ['Drizzle', 'drizzle'],
  55: ['Heavy drizzle', 'drizzle'],
  56: ['Freezing drizzle', 'drizzle'],
  57: ['Freezing drizzle', 'drizzle'],
  61: ['Light rain', 'rain'],
  63: ['Rain', 'rain'],
  65: ['Heavy rain', 'rain'],
  66: ['Freezing rain', 'rain'],
  67: ['Heavy freezing rain', 'rain'],
  71: ['Light snow', 'snow'],
  73: ['Snow', 'snow'],
  75: ['Heavy snow', 'snow'],
  77: ['Snow grains', 'snow'],
  80: ['Rain showers', 'rain'],
  81: ['Heavy rain showers', 'rain'],
  82: ['Violent rain showers', 'rain'],
  85: ['Snow showers', 'snow'],
  86: ['Heavy snow showers', 'snow'],
  95: ['Thunderstorm', 'thunderstorm'],
  96: ['Thunderstorm with hail', 'thunderstorm'],
  99: ['Severe thunderstorm with hail', 'thunderstorm'],
};

function describe(code) {
  const [condition, icon] = WMO[code] || ['Unknown', 'cloudy'];
  return { condition, icon };
}

export function deriveWarning(w) {
  if (!w?.available) return null;
  const t = WEATHER_THRESHOLDS;
  const warnings = [];

  if ([95, 96, 99].includes(w.weather_code)) {
    warnings.push('⛈️ Thunderstorms expected — keep outdoor plans flexible and have an indoor backup.');
  }
  if ((w.precipitation_probability ?? 0) >= t.heavyRainProbability && (w.precipitation_mm ?? 0) >= 5) {
    warnings.push(
      `⚠️ Heavy rain expected (${w.precipitation_probability}% chance, ~${Math.round(w.precipitation_mm)} mm) — consider an indoor alternative.`,
    );
  } else if ((w.precipitation_mm ?? 0) >= t.heavyRainMm) {
    warnings.push(`⚠️ Heavy rain expected (~${Math.round(w.precipitation_mm)} mm) — consider an indoor alternative.`);
  }
  if ([75, 86].includes(w.weather_code)) {
    warnings.push('❄️ Heavy snowfall expected — check road and transport conditions before heading out.');
  }
  if ((w.temp_max ?? -Infinity) >= t.extremeHeatC) {
    warnings.push(`🥵 Extreme heat (up to ${Math.round(w.temp_max)}°C) — plan outdoor sightseeing for early morning or evening.`);
  }
  if ((w.temp_min ?? Infinity) <= t.extremeColdC) {
    warnings.push(`🥶 Extreme cold (down to ${Math.round(w.temp_min)}°C) — dress in layers and limit long outdoor stretches.`);
  }
  if ((w.wind_speed_max ?? 0) >= t.highWindKmh || (w.wind_gusts_max ?? 0) >= t.highGustKmh) {
    const gust = Math.round(Math.max(w.wind_gusts_max ?? 0, w.wind_speed_max ?? 0));
    warnings.push(`💨 High winds (gusts up to ${gust} km/h) — boat trips, cable cars and viewpoints may be affected.`);
  }

  return warnings.length ? warnings.join('\n') : null;
}

function unavailable(date, reason) {
  return { date, available: false, reason };
}

async function fetchForecast(lat, lon, startDate, endDate) {
  const url = `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    daily: [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_sum',
      'precipitation_probability_max',
      'wind_speed_10m_max',
      'wind_gusts_10m_max',
    ].join(','),
    timezone: 'auto',
    start_date: startDate,
    end_date: endDate,
  })}`;
  return fetchJson(url, { timeoutMs: 10_000 });
}

/**
 * Returns one weather summary per trip date (in order), each with a derived
 * `warning` (string | null). Never throws — weather is best-effort.
 */
export async function getTripWeather(lat, lon, startDate, numDays) {
  const dates = Array.from({ length: numDays }, (_, i) => toIsoDate(addDays(startDate, i)));
  const today = todayIso();
  const horizon = toIsoDate(addDays(today, FORECAST_HORIZON_DAYS));

  const inRange = dates.filter((d) => d >= today && d <= horizon);
  let byDate = {};

  if (inRange.length) {
    const from = inRange[0];
    const to = inRange[inRange.length - 1];
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}:${from}:${to}`;
    try {
      const body = await cache.wrap(key, () => fetchForecast(lat, lon, from, to));
      const d = body.daily;
      d.time.forEach((date, i) => {
        const code = d.weather_code[i];
        byDate[date] = {
          date,
          available: true,
          weather_code: code,
          ...describe(code),
          temp_max: d.temperature_2m_max[i],
          temp_min: d.temperature_2m_min[i],
          precipitation_mm: d.precipitation_sum[i],
          precipitation_probability: d.precipitation_probability_max[i],
          wind_speed_max: d.wind_speed_10m_max[i],
          wind_gusts_max: d.wind_gusts_10m_max[i],
          fetched_at: new Date().toISOString(),
        };
      });
    } catch (err) {
      console.warn('[weather] forecast fetch failed:', err.message);
    }
  }

  return dates.map((date) => {
    let summary = byDate[date];
    if (!summary) {
      if (date < today) summary = unavailable(date, 'past');
      else if (date > horizon) summary = unavailable(date, 'beyond_forecast_range');
      else summary = unavailable(date, 'fetch_failed');
    }
    return { ...summary, warning: deriveWarning(summary) };
  });
}

// Compact text version for the Gemini prompt.
export function weatherForPrompt(weatherDays) {
  return weatherDays
    .map((w, i) => {
      if (!w.available) {
        return `Day ${i + 1} (${w.date}): forecast not available yet${w.reason === 'beyond_forecast_range' ? ' (too far ahead) — assume typical seasonal weather' : ''}`;
      }
      return `Day ${i + 1} (${w.date}): ${w.condition}, ${Math.round(w.temp_min)}–${Math.round(w.temp_max)}°C, rain chance ${w.precipitation_probability ?? 0}% (${w.precipitation_mm ?? 0} mm), wind up to ${Math.round(w.wind_speed_max ?? 0)} km/h${w.warning ? ` — WARNING: ${w.warning.replace(/\n/g, ' ')}` : ''}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// "Right now" weather + 5-day outlook for the dashboard card.
// ---------------------------------------------------------------------------

const nowCache = new TtlCache({ ttlMs: 30 * 60 * 1000, maxEntries: 500 });

export async function getCurrentWeather(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  return nowCache.wrap(key, async () => {
    const url = `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
      latitude: lat.toFixed(3),
      longitude: lon.toFixed(3),
      current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      forecast_days: '5',
      timezone: 'auto',
    })}`;
    const body = await fetchJson(url, { timeoutMs: 10_000 });
    const c = body.current;
    return {
      current: {
        temp: c.temperature_2m,
        feels_like: c.apparent_temperature,
        humidity: c.relative_humidity_2m,
        wind_speed: c.wind_speed_10m,
        weather_code: c.weather_code,
        ...describe(c.weather_code),
        time: c.time,
      },
      daily: body.daily.time.map((date, i) => ({
        date,
        temp_max: body.daily.temperature_2m_max[i],
        temp_min: body.daily.temperature_2m_min[i],
        precipitation_probability: body.daily.precipitation_probability_max[i],
        weather_code: body.daily.weather_code[i],
        ...describe(body.daily.weather_code[i]),
      })),
      timezone: body.timezone,
    };
  });
}
