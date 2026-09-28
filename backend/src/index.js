import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { config } from './config.js';
import { asyncHandler, HttpError } from './lib/http.js';
import { requireAuth } from './middleware/auth.js';
import { itineraryRouter } from './routes/itinerary.js';
import { tripsRouter } from './routes/trips.js';
import { placesRouter } from './routes/places.js';
import { alertsRouter } from './routes/alerts.js';
import { bookingsRouter } from './routes/bookings.js';
import { savedPlacesRouter } from './routes/savedPlaces.js';
import { dashboardRouter, weatherRouter } from './routes/dashboard.js';
import { toolsRouter } from './routes/tools.js';
import { v2Router, v2EvalRouter } from './routes/v2.js';
import { groupsRouter } from './routes/groups.js';
import { refreshAllUpcomingTrips } from './jobs/weatherRefresh.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors());
app.use('/bookings/extract', express.json({ limit: '15mb' }));
app.use('/tools/price-check', express.json({ limit: '15mb' }));
// Agentic (v2) endpoints that accept photos / ticket files.
app.use(['/v2/bookings/extract', '/v2/tools/price-check', '/v2/chat'], express.json({ limit: '15mb' }));
app.use(express.json({ limit: '1mb' }));

// Render health check (also used by the app to wake the server from a cold start).
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Daily weather refresh trigger for an external scheduler (Render Cron Job,
// cron-job.org, GitHub Actions…). Needed because free Render instances sleep.
app.post(
  '/jobs/refresh-weather',
  asyncHandler(async (req, res) => {
    if (!config.cronSecret || req.get('x-cron-secret') !== config.cronSecret) {
      throw new HttpError(401, 'Unauthorized');
    }
    res.json(await refreshAllUpcomingTrips());
  }),
);

app.use('/itinerary', requireAuth, itineraryRouter);
app.use('/trips', requireAuth, tripsRouter);
app.use('/places', requireAuth, placesRouter);
app.use('/alerts', requireAuth, alertsRouter);
app.use('/bookings', requireAuth, bookingsRouter);
app.use('/saved-places', requireAuth, savedPlacesRouter);
app.use('/dashboard', requireAuth, dashboardRouter);
app.use('/weather', requireAuth, weatherRouter);
app.use('/tools', requireAuth, toolsRouter);

// Agentic AI (v2) — runs alongside v1; the app picks per user via its feature flag.
app.use('/v2/eval', v2EvalRouter); // internal only, protected by x-eval-secret
app.use('/v2/groups', requireAuth, groupsRouter); // group trips (agentic only)
app.use('/v2', requireAuth, v2Router);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : err.status || 500;
  if (status >= 500) console.error('[error]', req.method, req.path, err);
  res.status(status).json({
    error: status >= 500 && !(err instanceof HttpError) ? 'Something went wrong. Please try again.' : err.message,
    ...(process.env.NODE_ENV !== 'production' && err.details ? { details: err.details } : {}),
  });
});

app.listen(config.port, () => {
  console.log(`Journi API listening on :${config.port} (model: ${config.geminiModel}, places: ${config.googlePlacesApiKey ? 'Google' : 'Nominatim'})`);
});

if (config.enableInProcessCron) {
  // 06:00 UTC daily. Only fires while the instance is awake — pair with the
  // /jobs/refresh-weather endpoint or a Render Cron Job for reliability.
  cron.schedule('0 6 * * *', () => {
    refreshAllUpcomingTrips().catch((err) => console.error('[weather-job]', err));
  });
}
