// Central place for environment configuration. Every external API key lives
// here (server-side only) and is never sent to the mobile client.

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT) || 4000,

  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),

  geminiApiKey: required('GEMINI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  // Used in order when the primary model is overloaded (503) or rate limited.
  geminiFallbackModels: (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.1-flash-lite,gemini-3.5-flash')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean),
  // "low" | "minimal" | "high" (Gemini 3 models only). Empty = model default.
  geminiThinkingLevel: process.env.GEMINI_THINKING_LEVEL ?? 'low',

  // Optional: when set, Google Places powers search/photos; otherwise we fall
  // back to OpenStreetMap Nominatim + Wikipedia images (both free).
  googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY || null,

  // Protects POST /jobs/refresh-weather so only your scheduler can call it.
  cronSecret: process.env.CRON_SECRET || null,
  // Run the daily weather refresh in-process (node-cron). Disable if you use
  // an external scheduler (Render Cron Job) instead.
  enableInProcessCron: process.env.ENABLE_IN_PROCESS_CRON !== 'false',

  // Agentic (v2) features. The daily weather job's decision-making runs through
  // the Weather Watcher agent unless this is "false" (then the fixed v1 logic runs).
  agenticWeatherWatcher: process.env.AGENTIC_WEATHER_WATCHER !== 'false',
  // Protects the internal POST /v2/eval/run endpoint (x-eval-secret header).
  // Falls back to CRON_SECRET so one secret is enough for a small deployment.
  evalSecret: process.env.EVAL_SECRET || process.env.CRON_SECRET || null,

  // Nominatim & Wikipedia require an identifying User-Agent.
  userAgent: process.env.HTTP_USER_AGENT || 'JourniApp/1.0 (trip planner; contact: admin@journi.app)',

  cacheTtlMs: {
    weather: 3 * 60 * 60 * 1000, // 3 hours
    exchange: 3 * 60 * 60 * 1000, // 3 hours
    places: 24 * 60 * 60 * 1000, // 1 day
    images: 7 * 24 * 60 * 60 * 1000, // 1 week
  },
};
