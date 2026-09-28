# Journi → Agentic AI — Full Conversion Prompt

This is the complete prompt to convert Journi from an AI-powered app (single, well-prompted Gemini calls inside a fixed, hardcoded sequence) into a genuinely agentic system, where the AI itself decides which tools to call, in what order, and when it has enough information to respond — without changing your existing tech stack, database, or working features.

## What "agentic" means here, concretely

Right now: your Express routes decide the sequence ("always fetch weather → always fetch currency → call Gemini once") and Gemini fills in content within that fixed sequence.

After this conversion: your Express routes expose small, reusable **tools** (functions), and an **agent loop** lets Gemini itself decide, step by step, which tools to call, based on what the specific request actually needs — checking weather only when it decides that's relevant, skipping steps it judges unnecessary, and calling additional tools you never explicitly scripted for that exact case.

## Ground rules before starting

- **Do not delete or break the existing working routes.** Build every agentic version alongside the current one, behind a new route prefix (`/v2/...`) and a feature flag in the mobile app, so you can compare behavior and cost before committing to a full switch.
- **Reuse every existing backend function as a tool.** Weather, currency, places, budget math, Supabase queries — none of this logic gets rewritten, only re-exposed as a callable tool for the agent loop instead of being called directly by your route code.
- **Log everything.** You cannot debug or improve agentic behavior you can't see. Every tool call, from every agent, gets logged before anything else is built.

---

## Full implementation prompt

```
Convert Journi's AI features from single-call Gemini prompts into a true multi-agent system. Keep the existing stack: Node.js + Express 5 (ES modules) on Render, Supabase (Postgres + RLS), Zod validation on every request/response, Gemini API (gemini-3.5-flash-lite with existing fallback chain). Add the Vercel AI SDK (the `ai` npm package) to manage the agent loops, using its Google provider to call Gemini with tool-calling and a step limit (stopWhen: stepCountIs(N)).

Reuse every existing backend function (get_weather, get_currency_rate, place search/details, budget calculation, Supabase queries) as callable tools passed into the AI SDK's tool-calling interface — do not rewrite this logic, only wrap it so the model can call it directly instead of your route code calling it for the model.

============================================================
SHARED INFRASTRUCTURE (build this first, once)
============================================================

1. New Supabase table: agent_tool_logs
   Columns: id, agent_name (text), trip_id (nullable, references trips), tool_name (text), arguments (jsonb), result (jsonb), created_at (timestamptz default now())
   Apply RLS so a user can only see logs tied to their own trips (join through trips.user_id), except this table is primarily for your own debugging, so a service-role-only read path is also fine.

2. A shared "runAgent" wrapper function (e.g., lib/agents/runAgent.js) that every agent uses. It should:
   - Accept: agentName, systemPrompt, tools (object of tool definitions), messages, tripId (nullable), stepLimit
   - Call the Vercel AI SDK's generateText or streamText with the given tools and stopWhen: stepCountIs(stepLimit)
   - On every tool call the model makes, log it to agent_tool_logs (agent_name, trip_id, tool_name, arguments, result) via an onStepFinish or equivalent callback
   - Validate the final structured output against a Zod schema (matching your existing validation pattern) before returning, with one retry if validation fails (matching your existing self-correcting retry pattern for malformed JSON)
   - Return both the final result and the full list of tool calls made, so calling code / the frontend can show "what the agent did" if useful for debugging or transparency

3. Wrap each existing backend function (weather, currency, places, budget, Supabase reads/writes) as an AI-SDK-compatible tool definition: a name, a description (written carefully — the model decides when to call a tool based on this description, so be specific about what it does and when it's useful), a Zod input schema, and an execute function that calls your existing logic unchanged.

============================================================
ORCHESTRATOR (new — sits in front of chat requests)
============================================================
Route: POST /v2/chat (replaces the role of the current chat handling inside /itinerary/refine for agentic-flagged requests)

Given a user's chat message and tripId, decides which specialized agent(s) below to invoke, in what order, and composes the final reply.

TOOLS (each of these calls one of the specialized agents below, passing along tripId and relevant context):
- invoke_planner_agent(tripId, userMessage)
- invoke_budget_agent(tripId)
- invoke_price_check_agent(tripId, imageData) — only relevant if the message includes an attached photo
- get_weather(lat, lng, startDate, endDate) — exposed directly too, so the Orchestrator can answer simple factual questions itself without invoking a full sub-agent

Use runAgent with agentName "orchestrator", stepLimit 4. The system prompt should instruct: resolve simple factual questions directly using get_weather or similar tools without invoking a sub-agent; invoke invoke_planner_agent for any request that changes the itinerary; invoke invoke_budget_agent after any planner change that could affect cost, or when the user explicitly asks about budget; invoke invoke_price_check_agent when an image is attached. Compose one clear, conversational reply referencing whatever sub-agents were invoked.

============================================================
AGENT 1: PLANNER (replaces the agentic-eligible parts of /itinerary/generate and /itinerary/refine)
============================================================
Route: POST /v2/itinerary/generate, POST /v2/itinerary/refine

TOOLS (wrapping your existing functions):
- get_weather(lat, lng, startDate, endDate)
- get_currency_rate(fromCurrency, toCurrency)
- search_places(query, near)
- get_place_details(placeId)
- add_activity(tripId, day, timeSlot, place)
- remove_activity(tripId, day, activityId)
- fill_slot(tripId, day, timeSlot, query)
- change_dates(tripId, newStartDate, newEndDate)
- change_destination(tripId, newDestination)
- save_itinerary_state(tripId, updatedDays) — commits the final result to itinerary_days, matching your existing atomic save_trip_plan pattern where relevant

runAgent config: agentName "planner", stepLimit 8.

System prompt instructions: for a new trip, decide what research is needed (weather for the date range, and enough place searches to build a full day-by-day plan) before generating the itinerary — do not assume a fixed number of searches, decide based on trip length and destination. For a refinement request, only call the tools actually relevant to that specific request (e.g., renaming a day's theme needs no weather/currency check at all; adding an outdoor activity should check weather first). Mark any day whose content changed with the existing "Updated" badge flag in the returned itinerary JSON. If the step limit is reached before the agent is confident in a complete answer, return the partial result along with a specific clarifying question for the user, rather than guessing to fill gaps.

============================================================
AGENT 2: BUDGET (new agent layer over existing budget calculation logic)
============================================================
Route: POST /v2/budget/reconcile — called automatically by the Orchestrator after Planner commits changes, or directly by the user asking about budget

TOOLS:
- get_current_itinerary(tripId)
- get_currency_rate(fromCurrency, toCurrency)
- get_flight_cost(tripId) — must respect any "Entered by you" manual value and never overwrite it, matching existing behavior
- get_bookings_total(tripId)
- update_budget_breakdown(tripId, categories) — writes to trip_budget
- flag_budget_concern(tripId, message) — call this specifically when the new total would exceed the user's set budget limit by more than 15%

runAgent config: agentName "budget", stepLimit 5.

System prompt instructions: decide whether this itinerary change actually affects cost before doing a full recalculation — skip pure informational edits (e.g., a stay note) and always recalculate after activity/date/destination changes. Produce the same "💰 Budget +₹800 → ₹23,350" style delta message your app already shows, only fire flag_budget_concern when the 15% threshold is crossed, not on every minor change.

============================================================
AGENT 3: TICKET (replaces /bookings/extract)
============================================================
Route: POST /v2/bookings/extract

TOOLS:
- extract_fields_from_image(imageData) — wraps your existing Gemini-based extraction
- find_matching_trip(tripDates, destination) — matches against the user's trips by date range
- convert_currency(amount, currencyCode)
- flag_low_confidence_field(fieldName, extractedValue, reason) — does NOT save automatically; returns this to the frontend for user confirmation
- save_booking(tripId, bookingData) — only called once all fields are either high-confidence or user-confirmed

runAgent config: agentName "ticket", stepLimit 4.

System prompt instructions: extract all fields, then explicitly evaluate each one's confidence (ambiguous dates, unclear currency symbols, illegible handwriting/text) before deciding to save directly vs. flag for confirmation. Multi-segment tickets (outbound + return) should be recognized and split into separate booking calls, matching existing behavior.

============================================================
AGENT 4: PRICE-CHECK (replaces /tools/price-check)
============================================================
Route: POST /v2/tools/price-check

TOOLS:
- extract_price_from_image(imageData)
- convert_currency(amount, currencyCode)
- get_typical_price_range(item, location) — new: can call search_places or perform a general lookup for local price context if the model decides its own knowledge is insufficient for this specific item/location

runAgent config: agentName "price_check", stepLimit 4.

System prompt instructions: decide whether you already have enough confidence to judge fair/high/overpriced from general knowledge, or whether you should call get_typical_price_range first — call it for less common items or less-documented locations, skip it for well-known cases (e.g., a standard city taxi fare) to save a step.

============================================================
AGENT 5: WEATHER WATCHER (replaces the fixed logic inside the node-cron job)
============================================================
The node-cron trigger and schedule stay exactly as they are — only the decision-making inside the daily job becomes agentic. Also exposed via the existing POST /jobs/refresh-weather endpoint for external schedulers.

TOOLS:
- list_upcoming_trips()
- get_weather(lat, lng, startDate, endDate)
- get_current_itinerary(tripId)
- suggest_itinerary_rework(tripId, day, reason) — generates a preview only, matching the existing Swap/Keep pattern; never writes directly to itinerary_days
- create_alert(tripId, message, severity) — writes to trip_alerts

runAgent config: agentName "weather_watcher", stepLimit 6 per trip.

System prompt instructions: for each upcoming trip, decide the appropriate response level to any forecast change — a minor shift might only warrant a low-severity alert; a storm on a day with mostly outdoor activities should also trigger suggest_itinerary_rework. Never call anything that writes the itinerary directly; reworks are always previews for the user to accept via the existing UI.

============================================================
HUMAN-IN-THE-LOOP GUARDRAILS (apply across all agents, non-negotiable)
============================================================
- Ticket Agent: any field flagged low-confidence must be confirmed by the user in the app before save_booking is called with that value.
- Weather Watcher: suggest_itinerary_rework only ever produces a preview; the itinerary is only changed when the user taps Swap in the existing UI flow.
- Budget Agent: flag_budget_concern must fire (not just a quiet number update) whenever a change pushes the total past the user's limit by more than 15%.
- All agents: every tool call is logged to agent_tool_logs before the response is returned to the user — no silent/unlogged tool calls anywhere.

============================================================
EVALUATION
============================================================
Build an internal-only endpoint, POST /v2/eval/run, that:
- Takes a fixed set of 10-15 real refinement requests (use your already-tested Vietnam trip's data as the base cases)
- Runs each through the new Planner agent (and Budget agent where relevant)
- Returns, per test case: the full tool-call sequence used, the final itinerary/budget diff, and a manual-comparison flag against what the old /itinerary/refine (v1) route produced for the same input
- Use this to check for: unnecessary tool calls (wasted Gemini requests), missed weather checks before outdoor-activity suggestions, and whether step limits were ever hit without a satisfactory result
- Iterate on each agent's system prompt and tool descriptions based on what this reveals — this is where most of the actual engineering effort will go, not in the initial wiring

============================================================
ROLLOUT STRATEGY
============================================================
1. Build shared infrastructure (agent_tool_logs, runAgent wrapper, tool wrappers) first.
2. Migrate Weather Watcher first — lowest stakes, not synchronously user-facing, easiest place to validate the tool-call loop and logging end to end.
3. Migrate Planner next — the core value, and where you'll most clearly feel the difference between agentic and single-call behavior.
4. Migrate Budget — depends on Planner's output, natural next step.
5. Migrate Ticket and Price-Check last — smaller scope, same "extract then self-verify" pattern, good final reps.
6. Keep v1 and v2 routes running in parallel behind a mobile-app feature flag until you're confident in cost, latency, and quality trade-offs — agent loops make more LLM calls per request than a single-shot prompt, so measure before fully committing.
```

---

## Notes for your specific project

- Your existing **Zod validation** pattern carries over directly — validate each agent's final structured output the same way you already validate Gemini's single-call responses today.
- Your existing **fallback chain** (`gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → `gemini-3.5-flash`) should apply to every agent call, not just the current single-call routes.
- Your **in-memory TTL cache** for weather/currency/places/images should sit underneath the tool functions themselves — so if the Planner agent calls `get_weather` three times in one loop (e.g., once for initial planning, once after a date change), the second and third calls hit the cache instead of a fresh API call, keeping agentic loops from being needlessly expensive.
- Row-Level Security on `trips`, `itinerary_days`, `trip_budget`, etc. doesn't change — agents write through the same Supabase service-role-authenticated backend code paths your current routes already use, so no new security surface is introduced.
