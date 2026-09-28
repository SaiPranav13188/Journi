// AGENT 4 — Price-Check. Reads prices with the existing extractor (which also
// gives a first verdict), then decides per item whether its own knowledge is
// enough or a local price lookup is worth a step. INR conversion stays
// deterministic, at the same rate the extractor used.

import { tool } from 'ai';
import { z } from 'zod';
import { HttpError } from '../lib/http.js';
import { runAgent, summarizeTrace } from '../lib/agents/runAgent.js';
import { checkPrices } from '../services/tools.js';
import { webSearchText } from '../services/gemini.js';
import { currencyRate } from './tools/research.js';

export const PRICE_CHECK_STEP_LIMIT = 4;

const VERDICTS = ['cheap', 'fair', 'high', 'very_high', 'unknown'];

const SYSTEM = `You are Journi's street-smart local price agent. You help Indian travellers avoid being overcharged.

1. Call extract_price_from_image first: it reads the prices in the photo and gives a first verdict per item with a typical range.
2. For each item decide whether you are already confident in the verdict:
   - Well-documented cases (a standard city taxi fare, a bottle of water, a coffee in a big tourist city) — trust your knowledge, no extra step.
   - Less common items, unusual services, or smaller / less-documented places — call get_typical_price_range for them (several items can be looked up in the same step).
3. Use convert_currency only if you need a rupee figure the extraction didn't give you.
You have very few steps; don't look up what you already know.

Finish with ONLY this JSON (no markdown). Include every item from the extraction, in the same order, with your final judgement:
{
  "items": [ { "name": "...", "verdict": "cheap" | "fair" | "high" | "very_high" | "unknown", "typical_low": number or null, "typical_high": number or null, "note": "max 15 words" } ],
  "summary": "one sentence overall verdict",
  "tip": "one practical tip (how to bargain, where it's cheaper…)"
}`;

const PriceAgentOutput = z.object({
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        verdict: z
          .string()
          .transform((s) => s.toLowerCase().trim().replace(/\s+/g, '_'))
          .pipe(z.enum(VERDICTS))
          .catch('unknown'),
        typical_low: z.coerce.number().min(0).nullish().catch(null),
        typical_high: z.coerce.number().min(0).nullish().catch(null),
        note: z.string().nullish().transform((v) => v || null),
      }),
    )
    .default([]),
  summary: z.string().nullish().transform((v) => v || null),
  tip: z.string().nullish().transform((v) => v || null),
});

/**
 * @param opts { userId, tripId?, base64, mimeType, place, countryCode, note, agentName? }
 * @returns PriceCheckResult (v1 shape) + agent trace
 */
export async function runPriceCheckAgent({ userId, tripId = null, base64, mimeType, place, countryCode = null, note = null, agentName = 'price_check' }) {
  const ctx = { base: null, fatal: null };

  const tools = {
    extract_price_from_image: tool({
      description: 'Reads every priced item in the attached photo (menu, price tag, taxi quote, receipt…) with its price, currency, rupee value, and a first fair/high verdict with a typical local range. Call it first, once.',
      inputSchema: z.object({}),
      execute: async () => {
        if (!ctx.base) {
          try {
            ctx.base = await checkPrices({ base64, mimeType, place, countryCode, note });
          } catch (err) {
            // "No prices in this photo" etc. — remembered so the traveller gets the same message as v1.
            if (err instanceof HttpError && err.status === 422) ctx.fatal = err;
            throw err;
          }
        }
        const b = ctx.base;
        return {
          what: b.what,
          currency: b.currency,
          items: b.items.map((i) => ({ name: i.name, price: i.price, price_inr: i.price_inr, verdict: i.verdict, typical_low: i.typical_low, typical_high: i.typical_high, note: i.note })),
          summary: b.summary,
        };
      },
    }),

    convert_currency: tool({
      description: 'Converts an amount in a currency (ISO code) to Indian Rupees at the live rate.',
      inputSchema: z.object({ amount: z.number().min(0), currencyCode: z.string().length(3) }),
      execute: async ({ amount, currencyCode }) => {
        const r = await currencyRate(currencyCode, 'INR');
        return { amount, currency: r.from, inr: Math.round(amount * r.rate), rate_to_inr: r.rate };
      },
    }),

    get_typical_price_range: tool({
      description: 'Looks up what locals and savvy tourists typically pay for an item or service in a specific place right now (web search). Use only for items or places you are not confident about.',
      inputSchema: z.object({
        item: z.string().min(2).describe('e.g. "30-minute cyclo ride"'),
        location: z.string().min(2).describe('City or area, e.g. "Hoi An Old Town, Vietnam"'),
      }),
      execute: async ({ item, location }) => {
        const facts = await webSearchText(
          `What do locals and savvy tourists typically pay for "${item}" in ${location} right now? Give a low–high range in the local currency, what affects the price, and any common tourist mark-up, in 3-4 short lines.`,
        );
        return facts
          ? { found: true, facts }
          : { found: false, note: 'Web lookup unavailable right now — use your own knowledge and say the verdict is approximate.' };
      },
    }),
  };

  let run;
  try {
    run = await runAgent({
      agentName,
      userId,
      tripId,
      stepLimit: PRICE_CHECK_STEP_LIMIT,
      systemPrompt: SYSTEM,
      tools,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', image: base64, mediaType: mimeType },
            { type: 'text', text: `I'm in ${place}${countryCode ? ` (${countryCode.toUpperCase()})` : ''}.${note ? ` ${note}` : ''} Is this price fair?` },
          ],
        },
      ],
      outputSchema: PriceAgentOutput,
      temperature: 0.2,
    });
  } catch (err) {
    if (ctx.fatal) throw ctx.fatal;
    // Same user-facing error as v1 when the photo can't be read.
    if (err instanceof HttpError && err.status === 400) throw new HttpError(422, 'We couldn’t read this photo. Try a clearer, closer shot of the prices.');
    throw err;
  }

  if (ctx.fatal) throw ctx.fatal;
  if (!ctx.base) throw new HttpError(502, 'We couldn’t check this photo. Please try again.');
  const base = ctx.base;
  const toInr = (v) => (v == null || base.rate == null ? null : Math.round(v / base.rate));
  const revised = run.output.items;

  // Merge the agent's final judgement into the extracted items (prices & rupee values stay as read).
  const items = base.items.map((item, i) => {
    const r = revised.find((x) => x.name.toLowerCase() === item.name.toLowerCase()) ?? revised[i];
    if (!r) return item;
    const low = r.typical_low ?? item.typical_low;
    const high = r.typical_high ?? item.typical_high;
    return { ...item, verdict: r.verdict, typical_low: low, typical_high: high, typical_low_inr: toInr(low), typical_high_inr: toInr(high), note: r.note ?? item.note };
  });

  return {
    what: base.what,
    currency: base.currency,
    rate: base.rate,
    items,
    summary: run.output.summary ?? base.summary,
    tip: run.output.tip ?? base.tip,
    agent: { runs: [summarizeTrace(agentName, run)] },
  };
}
