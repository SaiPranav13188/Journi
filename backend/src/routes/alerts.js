import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http.js';
import { listAlerts, markAlertsRead } from '../services/tripStore.js';

export const alertsRouter = Router();

alertsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    res.json({ alerts: await listAlerts(req.user.id, { unreadOnly }) });
  }),
);

// Body: { ids?: string[] } — omit ids to mark everything read.
alertsRouter.post(
  '/read',
  asyncHandler(async (req, res) => {
    const body = z.object({ ids: z.array(z.string().uuid()).optional() }).safeParse(req.body || {});
    await markAlertsRead(req.user.id, body.success ? body.data.ids : undefined);
    res.json({ ok: true });
  }),
);
