// AGENT 5 — Weather Watcher. The node-cron schedule and POST /jobs/refresh-weather
// stay as they are; only the decisions inside the daily job are agentic. For
// each upcoming trip the agent decides the response level to forecast changes:
// a low-severity alert for a minor shift, or an alert plus a rework preview
// when bad weather hits a day full of outdoor plans.
//
// Guardrail: the agent has NO tool that writes the itinerary. Reworks are
// stored as previews on an alert; the plan only changes when the traveller
// taps "Swap plan" in the app (POST /itinerary/apply-days).

import { randomUUID } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { supabaseAdmin as db } from '../lib/supabase.js';
import { daysBetweenInclusive, todayIso } from '../lib/dates.js';
import { runAgent } from '../lib/agents/runAgent.js';
import { logToolCall } from '../lib/agents/toolLog.js';
import { getTripWeather } from '../services/weather.js';
import { getTrip } from '../services/tripStore.js';
import { previewDayRework } from '../services/planner.js';
import { applyForecast, listUpcomingTrips, refreshTripWeather } from '../jobs/weatherRefresh.js';
import { compactWeather, fetchWeatherRange } from './tools/research.js';
import { compactItinerary } from './tools/itinerary.js';

export const WEATHER_WATCHER_STEP_LIMIT = 6;
const AGENT = 'weather_watcher';

const SYSTEM = `You are Journi's weather watcher. Once a day you review ONE upcoming trip's forecast and decide how to respond — like a thoughtful travel companion, not an alarm bell.

Response levels:
- Nothing new or only a minor shift (slightly more cloud, a small change in rain chance, a warning that cleared): do nothing, or at most one low-severity alert if it's useful to know.
- A meaningful new risk (heavy rain, extreme heat, high winds) on a day: one alert (medium or high severity) that says what to expect and what to do.
- Severe weather (storm, heavy rain, dangerous heat) on a day whose plan is mostly OUTDOOR: an alert AND suggest_itinerary_rework for that day with a clear reason. Check get_current_itinerary first to see which activities are outdoor.
- Mostly indoor days rarely need a rework.

Rules:
- Start with get_weather for the trip dates; each day shows the warning stored yesterday (previous_warning) so you can see what actually changed. Don't re-alert a warning the traveller already had.
- You can never change the itinerary yourself — reworks are previews the traveller may accept or ignore.
- Alert messages: one sentence, starting "Day N in <destination>: …".

Finish with ONLY this JSON: { "summary": "one line: what you found and did" }`;

const WatcherOutput = z.object({ summary: z.string().min(1) });

async function insertAlert(row) {
  // Don't stack identical unread alerts.
  const { data: existing } = await db
    .from('trip_alerts')
    .select('id')
    .eq('trip_id', row.trip_id)
    .eq('kind', row.kind)
    .eq('read', false)
    .eq('message', row.message)
    .limit(1);
  if (existing?.length) return { alert_id: existing[0].id, duplicate: true };
  const { data, error } = await db.from('trip_alerts').insert(row).select('id').single();
  if (error) throw new Error(`Could not save the alert: ${error.message}`);
  return { alert_id: data.id };
}

function createWatcherTools(trip, ctx) {
  const days = trip.itinerary_days || [];
  const loadState = async () => (ctx.state ??= await getTrip(trip.user_id, trip.id));

  return {
    get_weather: tool({
      description: 'Latest daily forecast for the trip location and dates, with each day\'s previously stored warning (previous_warning) so you can see what changed.',
      inputSchema: z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        startDate: z.string().describe('YYYY-MM-DD'),
        endDate: z.string().describe('YYYY-MM-DD'),
      }),
      execute: async (input) => {
        const weather = await fetchWeatherRange(input);
        return {
          days: weather.map((w) => {
            const stored = days.find((d) => d.date === w.date);
            return { day_number: stored?.day_number ?? null, ...compactWeather(w), previous_warning: stored?.weather_warning?.replace(/\n/g, ' ') ?? null };
          }),
        };
      },
    }),

    get_current_itinerary: tool({
      description: "The trip's current day-by-day plan: each activity with its time of day and whether it's indoor.",
      inputSchema: z.object({}),
      execute: async () => {
        const state = await loadState();
        return { destination: trip.destination_name, dates: `${trip.start_date} to ${trip.end_date}`, status: state.trip.status, days: compactItinerary(state.days) };
      },
    }),

    suggest_itinerary_rework: tool({
      description:
        'Prepares a PREVIEW of a reworked day (e.g. indoor alternatives in the same area) and attaches it to an alert, where the traveller can tap "Swap plan" or "Keep original". It never changes the itinerary. Use only for severe weather on a mostly-outdoor day.',
      inputSchema: z.object({
        day: z.number().int().min(1),
        reason: z.string().min(10).max(500).describe('What the weather is and what to change, e.g. "Thunderstorms all afternoon — swap the boat trip and hike for indoor or sheltered options nearby."'),
      }),
      execute: async ({ day, reason }) => {
        const state = await loadState();
        if (!state.days.some((d) => d.day_number === day)) throw new Error(`Day ${day} is not in this trip`);
        const preview = await previewDayRework({ state, targets: [{ day_number: day, instruction: reason }] });
        const saved = await insertAlert({
          trip_id: trip.id,
          user_id: trip.user_id,
          day_number: day,
          kind: 'rework_suggestion',
          message: `Day ${day} in ${trip.destination_name}: ${preview.reply || 'We prepared a weather-proof plan for this day.'}`.slice(0, 300),
          metadata: { reason, preview, severity: 'high' },
        });
        ctx.reworks++;
        return { preview_created: true, ...saved, new_plan: preview.days.map((d) => ({ day_number: d.day_number, theme: d.theme, activities: d.activities.map((a) => `${a.time_of_day}: ${a.title}${a.indoor ? ' (indoor)' : ''}`) })) };
      },
    }),

    create_alert: tool({
      description: 'Sends the traveller an in-app weather alert for this trip.',
      inputSchema: z.object({
        day: z.number().int().min(1).nullable().describe('Day number the alert is about, or null for the whole trip'),
        message: z.string().min(10).max(300),
        severity: z.enum(['low', 'medium', 'high']),
      }),
      execute: async ({ day, message, severity }) => {
        const saved = await insertAlert({ trip_id: trip.id, user_id: trip.user_id, day_number: day, kind: 'weather_warning', message, metadata: { severity } });
        if (!saved.duplicate) ctx.alerts++;
        return saved;
      },
    }),
  };
}

/** Anything for the agent to judge? No warnings now or before → nothing to decide (saves a model call per quiet trip). */
async function hasForecastSignal(trip) {
  const days = trip.itinerary_days || [];
  const weather = await getTripWeather(trip.latitude, trip.longitude, trip.start_date, daysBetweenInclusive(trip.start_date, trip.end_date));
  return weather.some((w) => w.warning) || days.some((d) => d.weather_warning);
}

async function watchTrip(trip) {
  const days = trip.itinerary_days || [];
  if (!(await hasForecastSignal(trip))) {
    await applyForecast(trip, days);
    return { skipped: true };
  }

  const ctx = { state: null, alerts: 0, reworks: 0 };
  const run = await runAgent({
    agentName: AGENT,
    userId: trip.user_id,
    tripId: trip.id,
    stepLimit: WEATHER_WATCHER_STEP_LIMIT,
    systemPrompt: SYSTEM,
    tools: createWatcherTools(trip, ctx),
    messages: [
      {
        role: 'user',
        content: `Trip: ${trip.destination_name}${trip.country ? `, ${trip.country}` : ''} (lat ${trip.latitude}, lng ${trip.longitude})
Dates: ${trip.start_date} to ${trip.end_date} (${days.length} days). Today: ${todayIso()}.
Review today's forecast for this trip and respond at the right level.`,
      },
    ],
    outputSchema: WatcherOutput,
    temperature: 0.2,
  });

  // Store the fresh forecast on each day (forecast fields only — the plan is untouched).
  await applyForecast(trip, days);
  return { skipped: false, alerts: ctx.alerts, reworks: ctx.reworks, summary: run.output.summary, tool_calls: run.toolCalls.length };
}

export async function runWeatherWatcher() {
  const started = Date.now();
  const trips = await listUpcomingTrips();
  // list_upcoming_trips is the job-level step that feeds the per-trip loops; log it like any tool call.
  await logToolCall({
    runId: randomUUID(),
    agentName: AGENT,
    toolName: 'list_upcoming_trips',
    args: {},
    result: { count: trips.length, trips: trips.map((t) => ({ id: t.id, destination: t.destination_name, dates: `${t.start_date} to ${t.end_date}` })) },
    durationMs: Date.now() - started,
  });

  const totals = { trips: trips.length, agentRuns: 0, skipped: 0, alerts: 0, reworks: 0, fallbacks: 0, newWarnings: 0 };
  for (const trip of trips) {
    try {
      const r = await watchTrip(trip);
      if (r.skipped) {
        totals.skipped++;
        continue;
      }
      totals.agentRuns++;
      totals.alerts += r.alerts;
      totals.reworks += r.reworks;
      console.log(`[weather-watcher] ${trip.destination_name} (${trip.id}): ${r.summary}`);
    } catch (err) {
      // Agent unavailable (quota, outage): never leave a traveller without warnings — use the v1 rules.
      console.error(`[weather-watcher] trip ${trip.id} agent failed, using v1 rules:`, err.message);
      totals.fallbacks++;
      try {
        totals.newWarnings += await refreshTripWeather(trip, trip.itinerary_days || []);
      } catch (e) {
        console.error(`[weather-job] trip ${trip.id} failed:`, e.message);
      }
    }
  }
  totals.newWarnings += totals.alerts;
  console.log(`[weather-watcher] ${JSON.stringify(totals)} in ${Date.now() - started}ms`);
  return totals;
}
