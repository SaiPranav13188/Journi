import { Router } from 'express';
import { asyncHandler, HttpError } from '../lib/http.js';
import { getPlaceDetails, searchPlaces } from '../services/places.js';
import { findImage } from '../services/images.js';

export const placesRouter = Router();

placesRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').slice(0, 120);
    res.json({ results: await searchPlaces(q) });
  }),
);

placesRouter.get(
  '/details/:placeId',
  asyncHandler(async (req, res) => {
    const { google_photo_name, ...place } = await getPlaceDetails(req.params.placeId);
    res.json({ place });
  }),
);

// Photo for a destination or activity location: ?query=Fushimi Inari Taisha, Kyoto
placesRouter.get(
  '/image',
  asyncHandler(async (req, res) => {
    const query = String(req.query.query || '').slice(0, 200);
    const placeId = req.query.place_id ? String(req.query.place_id) : null;
    const width = Math.min(Math.max(Number(req.query.width) || 800, 200), 1600);
    if (!query && !placeId) throw new HttpError(400, 'query or place_id is required');
    const image = await findImage({ query, placeId, width });
    res.set('Cache-Control', 'private, max-age=86400');
    res.json({ image });
  }),
);
