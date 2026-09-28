import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../lib/http.js';
import { supabaseAdmin as db } from '../lib/supabase.js';
import { findImage } from '../services/images.js';

export const savedPlacesRouter = Router();

const FIELDS = 'id, place_id, name, country, country_code, latitude, longitude, image_url, note, created_at';

const SavedPlaceSchema = z.object({
  place_id: z.string().max(200).nullish(),
  name: z.string().trim().min(1).max(120),
  country: z.string().trim().max(80).nullish(),
  country_code: z.string().length(2).nullish(),
  latitude: z.coerce.number().min(-90).max(90).nullish(),
  longitude: z.coerce.number().min(-180).max(180).nullish(),
  image_url: z.string().url().nullish(),
  note: z.string().trim().max(300).nullish(),
});

function fail(error, message) {
  if (!error) return;
  console.error('[saved-places]', message, error);
  if (error.code === '42P01' || error.code === 'PGRST205') {
    throw new HttpError(500, 'The database needs an update. Run supabase/migrations/004_dashboard.sql in the Supabase SQL Editor.');
  }
  throw new HttpError(500, message);
}

savedPlacesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await db.from('saved_places').select(FIELDS).eq('user_id', req.user.id).order('created_at', { ascending: false });
    fail(error, 'Could not load saved places');
    res.json({ places: data });
  }),
);

savedPlacesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = SavedPlaceSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Invalid place', parsed.error.issues);
    const place = { ...parsed.data, country_code: parsed.data.country_code?.toUpperCase() ?? null };
    if (!place.image_url) {
      const img = await findImage({ query: [place.name, place.country].filter(Boolean).join(', '), placeId: place.place_id, width: 800 });
      place.image_url = img?.url ?? null;
    }

    // Saving the same place twice just returns the existing entry.
    const { data: existing } = await db
      .from('saved_places')
      .select(FIELDS)
      .eq('user_id', req.user.id)
      .ilike('name', place.name)
      .limit(5);
    const dup = (existing || []).find((p) => (p.country_code || '') === (place.country_code || ''));
    if (dup) return res.json({ place: dup });

    const { data, error } = await db
      .from('saved_places')
      .insert({ ...place, user_id: req.user.id })
      .select(FIELDS)
      .single();
    fail(error, 'Could not save place');
    res.status(201).json({ place: data });
  }),
);

savedPlacesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { error } = await db.from('saved_places').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    fail(error, 'Could not remove place');
    res.status(204).end();
  }),
);
