import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../lib/http.js';
import { checkPrices } from '../services/tools.js';

export const toolsRouter = Router();

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

// POST /tools/price-check — photo of a menu/price tag/quote → fair-price verdicts in ₹.
toolsRouter.post(
  '/price-check',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        image_base64: z.string().min(100),
        mime_type: z.string().transform((m) => (m.toLowerCase() === 'image/jpg' ? 'image/jpeg' : m.toLowerCase())),
        place: z.string().trim().min(2).max(120),
        country_code: z.string().length(2).nullish(),
        note: z.string().trim().max(200).nullish(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'Please add a photo and the city you’re in');
    if (!IMAGE_TYPES.includes(parsed.data.mime_type)) throw new HttpError(415, 'Please use a photo (JPG, PNG, WEBP or HEIC)');
    if (Buffer.byteLength(parsed.data.image_base64, 'base64') > 10 * 1024 * 1024) throw new HttpError(413, 'That photo is too large');
    res.json(
      await checkPrices({
        base64: parsed.data.image_base64,
        mimeType: parsed.data.mime_type,
        place: parsed.data.place,
        countryCode: parsed.data.country_code ?? null,
        note: parsed.data.note ?? null,
      }),
    );
  }),
);
