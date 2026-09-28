// Gemini for the agent loops, through the Vercel AI SDK's Google provider.
// Every agent call gets the same fallback chain as the v1 single-call client
// (services/gemini.js): the primary model with one quick retry, then each
// fallback model — so a "high demand" spike on one model doesn't fail a loop.

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { wrapLanguageModel } from 'ai';
import { config } from '../../config.js';
import { HttpError } from '../http.js';

const google = createGoogleGenerativeAI({ apiKey: config.geminiApiKey });

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODELS = [config.geminiModel, ...config.geminiFallbackModels.filter((m) => m !== config.geminiModel)];

function statusOf(err) {
  return err?.statusCode ?? err?.status ?? err?.cause?.statusCode ?? 0;
}

const fallbackMiddleware = {
  specificationVersion: 'v4',
  wrapGenerate: async ({ params }) => {
    let lastError;
    for (const modelId of MODELS) {
      const model = google(modelId);
      // One quick retry per model, then move on — a busy model rarely recovers within seconds.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await model.doGenerate(params);
        } catch (err) {
          lastError = err;
          const status = statusOf(err);
          // 404 = model retired for this key: skip straight to the next model.
          if (status === 404) break;
          if (!RETRYABLE.has(status)) throw err;
          console.warn(`[agent-model] ${modelId} returned ${status} (attempt ${attempt + 1})`);
          if (attempt < 1) await sleep(2000);
        }
      }
      console.warn(`[agent-model] ${modelId} unavailable, trying next model`);
    }
    if (statusOf(lastError) === 429) {
      throw new HttpError(429, "You've hit the AI planner's free usage limit. Please wait a minute and try again.");
    }
    throw new HttpError(503, 'Our AI planner is very busy right now. Please try again in a minute.');
  },
};

/** The language model every agent uses (primary Gemini model + fallback chain). */
export const agentModel = wrapLanguageModel({ model: google(MODELS[0]), middleware: fallbackMiddleware });

/** Provider options matching the v1 client: Gemini 3 models get the configured thinking level. */
export function agentProviderOptions() {
  if (!config.geminiModel.startsWith('gemini-3') || !config.geminiThinkingLevel) return undefined;
  return { google: { thinkingConfig: { thinkingLevel: config.geminiThinkingLevel } } };
}
