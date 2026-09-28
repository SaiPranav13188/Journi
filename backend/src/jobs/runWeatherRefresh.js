// One-off entry point for a Render Cron Job: `npm run job:weather`.
import { refreshAllUpcomingTrips } from './weatherRefresh.js';

refreshAllUpcomingTrips()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
