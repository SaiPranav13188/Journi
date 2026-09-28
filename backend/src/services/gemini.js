// Minimal Gemini REST client with strict-JSON output and self-correcting
// retries when the model's JSON is malformed or fails schema validation.

import { config } from '../config.js';
import { fetchJson, HttpError } from '../lib/http.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_FORMAT_RETRIES = 2;

function extractText(body) {
  const parts = body?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
}

// Models sometimes wrap JSON in ``` fences or add stray prose; recover the object.
export function parseLooseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Response is not valid JSON');
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callModel(model, basePayload) {
  // Gemini 3 models support a thinking level; "low" keeps itineraries fast.
  const payload = model.startsWith('gemini-3') && config.geminiThinkingLevel
    ? { ...basePayload, generationConfig: { ...basePayload.generationConfig, thinkingConfig: { thinkingLevel: config.geminiThinkingLevel } } }
    : basePayload;
  return fetchJson(`${ENDPOINT}/${model}:generateContent`, {
    method: 'POST',
    timeoutMs: 90_000,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
    body: JSON.stringify(payload),
  });
}

// Tries the primary model with backoff, then each fallback model, so a
// temporary "high demand" spike on one model doesn't fail the whole request.
async function callGemini({ system, contents, temperature }) {
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      temperature,
      responseMimeType: 'application/json',
      maxOutputTokens: 16_384,
    },
  };

  const models = [config.geminiModel, ...config.geminiFallbackModels.filter((m) => m !== config.geminiModel)];
  let lastError;

  for (const model of models) {
    // One quick retry per model, then move on — a busy model rarely recovers within seconds.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await callModel(model, payload);
      } catch (err) {
        lastError = err;
        const status = err instanceof HttpError ? err.status : 0;
        // 404 = model retired for this key: skip straight to the next model.
        if (status === 404) break;
        if (!RETRYABLE.has(status)) throw err;
        console.warn(`[gemini] ${model} returned ${status} (attempt ${attempt + 1})`);
        if (attempt < 1) await sleep(2000);
      }
    }
    console.warn(`[gemini] ${model} unavailable, trying next model`);
  }

  const status = lastError instanceof HttpError ? lastError.status : 0;
  if (status === 429) throw new HttpError(429, "You've hit the AI planner's free usage limit. Please wait a minute and try again.");
  throw new HttpError(503, 'Our AI planner is very busy right now. Please try again in a minute.');
}

/**
 * Asks Gemini for JSON and validates it with a zod schema. On malformed output,
 * feeds the error back to the model and asks it to correct itself.
 */
export async function generateJson({ system, contents, schema, temperature = 0.7 }) {
  const convo = [...contents];
  let lastError;

  for (let attempt = 0; attempt <= MAX_FORMAT_RETRIES; attempt++) {
    const body = await callGemini({ system, contents: convo, temperature: attempt ? 0.2 : temperature });
    const text = extractText(body);

    if (!text) {
      const reason = body?.candidates?.[0]?.finishReason || body?.promptFeedback?.blockReason || 'empty response';
      lastError = new Error(`Gemini returned no content (${reason})`);
    } else {
      try {
        const json = parseLooseJson(text);
        const result = schema.safeParse(json);
        if (result.success) return result.data;
        lastError = new Error(
          result.error.issues
            .slice(0, 8)
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; '),
        );
      } catch (err) {
        lastError = err;
      }
      convo.push({ role: 'model', parts: [{ text }] });
    }

    console.warn(`[gemini] invalid output (attempt ${attempt + 1}): ${lastError.message}`);
    convo.push({
      role: 'user',
      parts: [
        {
          text: `Your previous response could not be used: ${lastError.message}. Respond again with ONLY the complete, corrected JSON object that follows the required format exactly. No markdown, no commentary.`,
        },
      ],
    });
  }

  throw new HttpError(502, 'The AI planner returned an unexpected response. Please try again.', lastError?.message);
}

// Gemini's Google Search grounding isn't available on every plan (free keys
// often get quota 0). Try it, and back off for a while when it's refused.
let webSearchDisabledUntil = 0;

/** Returns grounded plain-text facts from a web search, or null if unavailable. */
export async function webSearchText(prompt) {
  if (Date.now() < webSearchDisabledUntil) return null;
  try {
    const body = await fetchJson(`${ENDPOINT}/${config.geminiModel}:generateContent`, {
      method: 'POST',
      timeoutMs: 30_000,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }),
    });
    return extractText(body) || null;
  } catch (err) {
    if (err instanceof HttpError && [400, 403, 429].includes(err.status)) {
      webSearchDisabledUntil = Date.now() + 6 * 60 * 60 * 1000;
      console.warn(`[gemini] web search unavailable (${err.status}); using map + encyclopedia lookup for 6h`);
    } else {
      console.warn('[gemini] web search failed:', err.message);
    }
    return null;
  }
}
