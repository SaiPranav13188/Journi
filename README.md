# Journi — AI travel planner

Pick a destination and dates. Journi drafts a day-by-day itinerary using the live weather forecast and exchange rates, and estimates a budget in ₹ and the local currency. You then refine the plan by chatting with it until you tap **Finalize Plan**.

```
Journi/
├── mobile/     Expo (React Native, SDK 57, Expo Router) app
├── backend/    Node.js + Express API (deploy to Render)
└── supabase/   schema.sql — tables, RLS policies, atomic save function
```

| Piece | Tech |
|---|---|
| App | Expo SDK 57, Expo Router, Reanimated 4, expo-image, Supabase Auth (Google + email/password) |
| API | Express 5, zod validation, in-memory TTL cache, node-cron |
| AI | Google Gemini (`gemini-3.5-flash-lite` by default, with automatic fallback models). It is called only from the server and must return strict JSON, with automatic self-correcting retries |
| Places | Google Places (New) if a key is set, otherwise OpenStreetMap Nominatim |
| Photos | Google Place Photos, or the lead Wikipedia image of each landmark, dish or city |
| Weather | Open-Meteo (free, no key) |
| Currency | Frankfurter (ECB), with open.er-api.com as a fallback for currencies ECB doesn't cover |
| Data | Supabase Postgres with Row-Level Security |

---

## 1. Supabase

1. Create a project at [database.new](https://database.new).
2. Open **SQL Editor**, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
3. Turn on authentication:
   - **Email:** under **Authentication → Providers → Email**, email/password is on by default. New projects make users confirm their email address first, and the app handles that ("Check your inbox").
   - **Google:**
     1. In Google Cloud Console, create an **OAuth client ID** of type *Web application*.
     2. Add `https://<project-ref>.supabase.co/auth/v1/callback` as an authorised redirect URI.
     3. Paste the client ID and secret into **Authentication → Providers → Google**.
4. Under **Authentication → URL Configuration → Redirect URLs**, add:
   - `journi://auth/callback` (development and production builds)
   - `exp://**` (so Google sign-in works inside Expo Go)
5. Note these values from **Project Settings → API**: the Project URL, the **publishable (anon)** key (goes in the app), and the **service role** key (goes in the backend only).

## 2. Backend (local)

```bash
cd backend
cp .env.example .env      # fill in SUPABASE_*, GEMINI_API_KEY (free at https://aistudio.google.com/apikey)
npm install
npm run dev               # http://localhost:4000/health
```

### Deploy to Render

- **Blueprint:** New → **Blueprint** → select the repo. [`backend/render.yaml`](backend/render.yaml) sets up the web service and its health check.
- **Manual:** create a Web Service with root dir `backend`, build command `npm ci`, start command `npm start`, and health check path `/health`.

Either way, add the environment variables from `.env.example`. Every API key stays on Render; none of them ship in the app.

**Daily weather re-check.** Free Render instances go to sleep, so the in-process 06:00 UTC cron only runs while the instance happens to be awake. For a reliable daily run, use one of these:
- a Render **Cron Job** running `npm run job:weather`, or
- any external scheduler calling `POST https://<your-api>/jobs/refresh-weather` with the header `x-cron-secret: <CRON_SECRET>`.

## 3. Mobile app

```bash
cd mobile
cp .env.example .env      # EXPO_PUBLIC_API_URL + Supabase URL & publishable key
npm install
npx expo start            # scan the QR code with Expo Go
```

When the backend runs on your computer, set `EXPO_PUBLIC_API_URL=http://<your-computer-LAN-IP>:4000`. `localhost` won't work because it points at the phone itself.

---

## How it works

**Generate:** `POST /itinerary/generate`
1. Fetches the forecast (Open-Meteo), the INR→local rate (Frankfurter) and a cover photo, all in parallel. Each is cached for a few hours.
2. Sends Gemini the destination, dates and a per-day weather summary. Gemini replies with strict JSON: a theme per day, 3–5 activities ordered morning → evening, a meal suggestion, per-unit budget inputs and a short chat reply.
3. The server validates the JSON with zod. If it's malformed, the error goes back to Gemini, which is asked to correct itself (up to 2 retries).
4. The server then assigns dates, attaches weather warnings, and computes the budget:
   - accommodation = per-night rate × nights
   - food and transport = per-day rate × days
   - activities = sum of every activity's cost

   Doing this on the server means totals always match the itinerary.

**Refine:** `POST /itinerary/refine`
- Gemini receives the full chat history plus the current itinerary and returns a new **full** itinerary and a reply.
- It can change the number of days (dates and budget are recomputed), move the start date, or switch the destination (re-geocoded, with new weather and currency).
- Accommodation notes the user typed are carried over.
- For saved trips, the new state and both messages are written to Supabase in one transaction (`save_trip_plan`).

**Save vs Finalize**
- An unsaved plan, including its chat, is kept on the device, so closing the app mid-planning loses nothing.
- **Save Trip** writes everything to Supabase. The trip stays editable, and every later refinement is saved automatically.
- **Finalize Plan** marks the trip complete. **Reopen** unlocks it again.

**Weather warnings**
- Thresholds live in `backend/src/services/weather.js`:
  - rain chance ≥ 70% with ≥ 5 mm, or ≥ 15 mm of rain
  - thunderstorms or heavy snow
  - maximum ≥ 38 °C or minimum ≤ −5 °C
  - wind ≥ 50 km/h or gusts ≥ 70 km/h
- Forecasts only reach ~16 days ahead. Days further out show "Forecast soon" and fill in as the trip gets closer.
- Opening a trip refreshes a stale forecast.
- The daily job records a `trip_alerts` row whenever a new warning appears. It shows up on the home screen and in the Alerts inbox.

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Render health check / cold-start wake-up |
| POST | `/itinerary/generate` | Create an initial plan (not saved) |
| POST | `/itinerary/refine` | Conversational update (persists if `trip_id` is given) |
| GET / POST | `/trips` | List saved trips / save a new one |
| GET / PUT / PATCH / DELETE | `/trips/:id` | Load (refreshes stale weather) / save state / finalize or reopen / delete |
| PATCH | `/trips/:id/days/:day` | Optional accommodation note |
| GET | `/places/search?q=` · `/places/details/:id` · `/places/image?query=` | Destination search, details, photos |
| GET / POST | `/alerts` · `/alerts/read` | In-app weather alerts |
| POST | `/jobs/refresh-weather` | Daily forecast refresh (needs `x-cron-secret`) |

Every route except `/health` and `/jobs/*` requires `Authorization: Bearer <supabase access token>`.

## Agentic AI (v2)

The v1 routes above follow a fixed sequence: fetch weather, fetch the exchange rate, then make one Gemini call. The v2 routes hand those steps to Gemini as **tools** instead. Gemini decides which tools each request needs, in what order, and when it has enough information to answer. The agent loops use the Vercel AI SDK (`ai` + `@ai-sdk/google`), with a step limit set by `stopWhen: stepCountIs(N)`. v1 is unchanged, and both versions run side by side.

**Setup**
1. Run `supabase/migrations/006_agentic.sql` once. It adds the `agent_tool_logs` table and `trip_alerts.metadata`.
2. Backend env (optional): `AGENTIC_WEATHER_WATCHER` (default `true`) and `EVAL_SECRET` (falls back to `CRON_SECRET`).
3. App: turn on **Profile → Agentic AI (beta)**. The switch is saved per user in Supabase user metadata. `EXPO_PUBLIC_AGENTIC_AI=true` turns it on for users who haven't set it. When it's on, chat, new-trip planning, ticket reading and price checks call `/v2`.

**Agents** (`backend/src/agents/`), all built on the shared `runAgent` wrapper in `backend/src/lib/agents/runAgent.js`:

| Agent | Route | Steps | Tools |
|---|---|---|---|
| Orchestrator | `POST /v2/chat` | 4 | `invoke_planner_agent`, `invoke_budget_agent`, `invoke_price_check_agent` (needs an attached photo), `get_weather` |
| Planner | `POST /v2/itinerary/generate` · `/v2/itinerary/refine` | 8 | `get_weather`, `get_currency_rate`, `search_places`, `get_place_details`, `add_activity`, `remove_activity`, `fill_slot`, `change_dates`, `change_destination`, `save_itinerary_state` |
| Budget | `POST /v2/budget/reconcile` (the Orchestrator also calls it) | 5 | `get_current_itinerary`, `get_currency_rate`, `get_flight_cost`, `get_bookings_total`, `update_budget_breakdown`, `flag_budget_concern` |
| Ticket | `POST /v2/bookings/extract` | 4 | `extract_fields_from_image`, `find_matching_trip`, `convert_currency`, `flag_low_confidence_field`, `save_booking` |
| Price-Check | `POST /v2/tools/price-check` | 4 | `extract_price_from_image`, `convert_currency`, `get_typical_price_range` |
| Weather Watcher | daily cron + `POST /jobs/refresh-weather` | 6 per trip | `list_upcoming_trips` (job level), `get_weather`, `get_current_itinerary`, `suggest_itinerary_rework`, `create_alert` |

`runAgent` does the following for every agent:
- It routes calls through the same Gemini fallback chain as v1.
- It logs every tool call to `agent_tool_logs` before the response goes back. If that insert fails, the entry is written to the server log instead.
- If the step limit is hit mid-research, it asks for a wrap-up answer; the Planner returns a clarifying question instead of guessing.
- It validates the final JSON with zod and retries once on malformed output.
- It returns the full tool trace in `agent.runs`.

`GET /v2/agent-logs?trip_id=` returns the signed-in user's own logs. Tools reuse the existing services unchanged, and the in-memory caches sit underneath them, so repeated `get_weather` calls within one loop don't hit the weather API again.

**Guardrails (enforced in code, not only in prompts)**
- **Ticket:** `save_booking` refuses any booking that has a flagged field, and any trip that isn't the user's. Flagged bookings come back as `needs_confirmation`, and the app pre-fills the form and highlights the doubtful fields.
- **Weather Watcher:** has no tool that writes the itinerary. A rework is stored as a preview on a `rework_suggestion` alert. Tapping the alert opens **Swap plan / Keep original**, and only **Swap** applies it, through the existing `/itinerary/apply-days`.
- **Budget:** if the total ends up more than 15% over the trip's limit and the model didn't call `flag_budget_concern`, the server raises the concern itself and logs it as `forced_by_guardrail`. The tool also refuses to fire below the threshold.
- **Trip binding:** the trip an agent edits comes from the authenticated request. The model never picks a trip id to write to. Drafts are never written to the database.
- **Flight cost:** a flight cost the user entered ("Entered by you") is never overwritten.

**Evaluation:** `POST /v2/eval/run` is internal only and needs the header `x-eval-secret`. The body is `{ "trip_id": "<your Vietnam trip>", "case_ids"?: [...], "compare_v1"?: true }`.
- It runs 14 Vietnam refinement cases, such as renaming a theme, adding an outdoor hike, shifting dates or switching to Hoi An.
- The cases run through the Planner (and the Budget agent where relevant) and through v1, on throw-away copies. Nothing is saved to the trip.
- For each case it reports the tool sequence, the itinerary and budget diff for each version, and automatic checks: unnecessary tools, missed weather checks before outdoor additions, repeated tools, and step-limit hits.
- Cases where v1 and v2 changed different things are flagged for manual review.
- Iterate on the prompts and tool descriptions in `backend/src/agents/` based on what it finds.

**Rollout order:** Weather Watcher (set `AGENTIC_WEATHER_WATCHER=false` to fall back to the v1 rules; the watcher also falls back per trip if the agent fails), then Planner, then Budget, then Ticket and Price-Check. Keep v1 as the default until the eval results, latency and Gemini usage look right. An agent loop makes several model calls per request, compared with one for v1.

## Group trips

Several people can plan one trip together. Group trips always use the agents; there is no v1 path.

**Setup:** run `supabase/migrations/007_groups.sql` once, after `006_agentic.sql`. It adds:
- `trip_members`, `group_polls`, `group_poll_votes` and `group_expenses`
- `trips.is_group` / `join_code`, and message authors
- read-only access rules for members
- live updates (Supabase Realtime)

**How it works**
- **Groups tab:** the owner shares a saved trip. That creates a join code like `JRN-4K7Q`, which friends enter to join. Everyone can chat and edit the plan; the organiser can remove people, and members can leave.
- **Group agent** (`backend/src/agents/group.js`, `POST /v2/groups/:tripId/chat`, 6 steps). Its tools:
  - `get_member_preferences`, `find_compromise`
  - `invoke_planner_agent`, `invoke_budget_agent`, `get_weather`
  - `create_poll`, `get_poll_results`, `close_poll`
  - `record_expense`, `get_balances`
  - `update_member_preferences`

  It balances everyone's interests, budget, pace and dietary needs. For an either/or disagreement it starts a poll instead of deciding. When everyone has voted, or someone taps **Close now**, the agent applies the winning option automatically.
- **Money:** the trip budget is a per-person estimate, and the group total is that × members. Shared expenses are split equally among the chosen people, like Splitwise. Balances show the fewest payments needed to settle up, e.g. "Rahul → Priya ₹1,300". Expenses can be added in the Group tab or just said in chat: "I paid ₹6,000 for the hotel".
- **Live:** each member's app listens for changes to the trip, chat, members, polls, votes and expenses, then refreshes.
- **Safety:** the backend checks membership on every group request. A member's edits are saved through the owner's atomic `save_trip_plan`. The group agent handles one AI request per trip at a time, so two people chatting at once can't overwrite each other's changes.

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/v2/groups` | My group trips / share one of my trips |
| POST | `/v2/groups/join` | Join with a code |
| GET | `/v2/groups/:tripId` | Members, polls, expenses, balances |
| POST | `/v2/groups/:tripId/chat` | Group agent |
| PUT | `/v2/groups/:tripId/preferences` | My interests, budget, pace, dietary needs |
| POST | `/v2/groups/:tripId/polls/:pollId/vote` · `/close` | Vote / end a poll early |
| POST / DELETE | `/v2/groups/:tripId/expenses[/:id]` | Shared expenses |
| DELETE | `/v2/groups/:tripId/members/:userId` | Leave, or remove someone (organiser only) |

## Additions beyond the original schema

- `trips.country_code` and `trips.cover_image_url`: needed for the currency lookup and the trip-list thumbnail.
- `trip_alerts` table: stores the in-app "new weather warning" notifications.
- `itinerary_days.meal_suggestion` is `jsonb` (`{ dish, where, description, estimated_cost_inr }`), not plain text.
- Dashboard (migration `004_dashboard.sql`): `trips.budget_limit_inr`, `saved_places` and `bookings` tables; map pins are stored as `lat`/`lng` on each activity.
- Budget figures are **mid-range estimates for one traveller, including return (up and down) flights** from the city chosen under "Flying from" (`trips.origin_city`, `trip_budget.flights_estimate` / `flight_note`). Existing databases: run `supabase/migrations/002_add_flights.sql` once.

## Place suggestions in chat

Asking things like "show me famous coffee shops near my Day 1 plan" (or tapping **Add places to Day N** on a day) returns 5–8 place cards with photos and ratings, each with **Add to Day N**. With `GOOGLE_PLACES_API_KEY` set, the places, photos and ratings come from Google Maps. Without it, Gemini picks well-known places and the ratings are labelled as AI estimates. Existing databases: run `supabase/migrations/003_chat_suggestions.sql` once.

## Photo credits

The onboarding photos in `mobile/assets/images/onboarding` come from Wikimedia Commons. See the `ATTRIBUTION.md` in that folder.
