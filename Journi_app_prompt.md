# Journi — AI Travel Planner Implementation Prompt

Build **Journi**, a real-time, AI-powered trip planning app using **Expo (React Native, managed workflow)**, a **Node.js/Express backend deployed on Render**, and **Supabase** for all data storage and authentication.

## Corrections / assumptions made (confirm or adjust before building)

- **AI model:** Claude's API is not free (low-cost, but pay-per-use). Using **Google Gemini API** instead for itinerary generation and conversational refinement, since it has a genuinely free tier suitable for this use case. If you'd rather pay for Claude/GPT for better output quality, swap the model call in the backend — the rest of the architecture doesn't change.
- **Stack:** Staying with Expo (not Android Studio/native Kotlin) — this app's features (search, forms, chat UI, API calls) don't require any native-only capability, so native development would only add build time with no functional benefit here.
- **Auth:** Supabase Auth configured for **both** Google Sign-In and email/password, per your requirement.

## Real-time data sources needed

| Need | Suggested API | Notes |
|---|---|---|
| Search any place worldwide | Google Places API (Autocomplete + Place Details), or OpenStreetMap Nominatim as a free fallback | Google Places has a monthly free credit; Nominatim is fully free but less polished autocomplete UX |
| Real-time weather + warnings | Open-Meteo API | Free, no API key required, provides forecast data (precipitation, wind speed, temperature extremes) used to derive "bad weather" warnings |
| Currency conversion (INR ↔ local currency) | exchangerate-api.com or Frankfurter API | Frankfurter is free, no key required, good for daily-rate conversion |
| AI itinerary generation + conversational refinement | Google Gemini API | Free tier; call server-side only, never from the client |

All external API keys are called **server-side only** (via the Render backend) — never embed keys in the Expo app.

---

## App flow

### 1. Destination search
- Search bar using Google Places Autocomplete (or Nominatim), returning worldwide results as the user types.
- On selecting a place, store its resolved coordinates, country, and place ID — needed later for weather and currency lookups.

### 2. Trip duration input
- Start date and end date pickers (`@react-native-community/datetimepicker` or a date-picker library compatible with Expo).
- Validate end date is after start date; compute trip length in days.

### 3. AI-generated itinerary (initial plan)
- On submitting destination + dates, call the backend's `POST /itinerary/generate` endpoint, which:
  1. Fetches current weather forecast for the destination's date range (Open-Meteo).
  2. Fetches current exchange rate between INR and the destination's local currency (Frankfurter), if the destination is outside India.
  3. Sends a structured prompt to Gemini including: destination, date range, number of days, and the fetched weather summary, asking for a **day-by-day itinerary** — each day with: a short theme/title, 3-5 activities/things to do with rough time-of-day ordering (morning/afternoon/evening), and one meal/food suggestion.
  4. Returns the structured itinerary (as JSON — instruct Gemini to respond in JSON only for reliable parsing) plus a budget estimate (see Budget section).
- Render the itinerary in a day-by-day scrollable view in the app, each day expandable to show its activities.

### 4. Conversational refinement (the core "feels like a conversation" requirement)
- Below or above the itinerary, show a chat-style interface: the user can type/send messages like "swap day 2's museum for something more outdoorsy" or "add a day trip to a nearby town."
- Each user message is sent to `POST /itinerary/refine` along with the **current itinerary state** and the full conversation history so far.
- Gemini responds with an **updated full itinerary** (not just a text reply) plus a short conversational acknowledgment (e.g., "Swapped the museum visit for a hiking trail on Day 2 — let me know if you'd like a different trail difficulty.").
- The app replaces the displayed itinerary with the updated version and appends both the user's message and the AI's conversational reply to a visible chat thread, so the whole back-and-forth feels like an ongoing conversation, not a form resubmission.
- This loop continues indefinitely until the user is satisfied and taps a "Finalize Plan" button — there's no fixed number of refinement turns.
- Store every message (role: user/assistant, content, timestamp) in Supabase against the trip, so the conversation history persists if the user closes and reopens the app mid-planning.

### 5. Save the plan
- "Save Trip" button persists the current itinerary (and full conversation history) to Supabase under the logged-in user's account.
- Trips list screen (home screen after login) shows all saved trips with destination, dates, and a thumbnail/summary.
- Users can reopen a saved trip and continue refining it conversationally even after saving — saving isn't a final lock, only "Finalize Plan" marks it as complete (see below).

### 6. Budget breakdown
- Generate a structured budget alongside the itinerary: estimated costs for accommodation (rough per-night estimate), food, local transport, activities/entry fees, and a total.
- Show the total and breakdown in **both INR and the destination's local currency** if the trip is international, using the live exchange rate fetched at generation time. Label clearly which currency each figure is shown in, and note the exchange rate used and its date/time (rates fluctuate, so timestamp this for transparency).
- Recompute the budget whenever the itinerary changes during conversational refinement (e.g., adding an extra activity updates the estimated total).

### 7. Optional daily accommodation info
- For each day in the itinerary, allow an **optional** field where the user can enter where they're staying that night (hotel name, address, or a free-text note like "Airbnb near city center").
- This is purely informational (not validated against a real booking API in this version) — just stored alongside that day's itinerary entry in Supabase.
- Leave blank/optional by default; don't block saving or finalizing the plan if left empty.

### 8. Weather warnings
- Using the Open-Meteo forecast data already fetched during itinerary generation (and re-fetched if the trip is refined or the date is close), flag any day in the itinerary where conditions cross a "bad weather" threshold — e.g., heavy rain probability above a set percentage, extreme heat/cold, or high wind speeds.
- Display a clear warning banner on the affected day's itinerary card (e.g., "⚠️ Heavy rain expected — consider an indoor alternative"), and mention it in the AI's conversational response if it's already aware of the forecast during initial generation (e.g., "I've planned Day 3 with mostly indoor activities since rain is forecast").
- Since forecasts become more accurate closer to the trip date, re-fetch weather data for saved upcoming trips periodically (e.g., once daily via a scheduled backend job) and update warnings if the forecast changes — notify the user in-app if a new warning appears for a trip they've already saved.

---

## Supabase schema (initial version)

- **users** — handled by Supabase Auth directly (Google + email/password)
- **trips**: `id`, `user_id`, `destination_name`, `destination_place_id`, `country`, `latitude`, `longitude`, `start_date`, `end_date`, `status` (`planning` / `finalized`), `created_at`, `updated_at`
- **itinerary_days**: `id`, `trip_id`, `day_number`, `date`, `theme`, `activities` (JSON array), `meal_suggestion`, `accommodation_note` (nullable, optional), `weather_summary` (JSON), `weather_warning` (nullable text)
- **trip_budget**: `id`, `trip_id`, `accommodation_estimate`, `food_estimate`, `transport_estimate`, `activities_estimate`, `total_inr`, `total_local_currency`, `local_currency_code`, `exchange_rate_used`, `exchange_rate_timestamp`
- **conversation_messages**: `id`, `trip_id`, `role` (`user` / `assistant`), `content`, `created_at`

Use Supabase Row-Level Security (RLS) so each user can only read/write their own trips, itinerary days, budgets, and conversation messages.

---

## Backend (Node.js/Express on Render)

- **`POST /itinerary/generate`** — accepts destination + dates, orchestrates weather + currency fetches, calls Gemini, returns structured itinerary + budget JSON.
- **`POST /itinerary/refine`** — accepts trip ID, user's refinement message, current itinerary state, calls Gemini with full context, returns updated itinerary + budget + conversational reply, and persists the new state to Supabase.
- **`POST /trips`** / **`GET /trips`** / **`GET /trips/:id`** — CRUD for saved trips, backed by Supabase (using the service role key server-side; RLS still applies for any direct client-side Supabase reads if you add those later).
- **`GET /health`** — for Render health checks.
- All Gemini, Google Places, and currency API keys stored as Render environment variables — never sent to or stored on the client.
- Since Render's free tier can cold-start after inactivity, show a "Planning your trip..." loading state in the app on the first request after idle periods, particularly relevant here since itinerary generation already takes a few seconds for the AI call itself.
- Prompt Gemini to **always respond in strict JSON** for itinerary/budget data (with a separate short natural-language field for the conversational reply), and validate/parse the response server-side with a fallback retry if the JSON is malformed, since LLM outputs occasionally don't perfectly follow format instructions.

---

## Non-functional requirements

- Handle the case where the AI's refinement changes the trip length or destination unexpectedly (e.g., user says "actually let's do 2 extra days") — recompute `itinerary_days` and `trip_budget` records accordingly rather than assuming a fixed day count.
- Cache weather and exchange rate lookups briefly (e.g., a few hours) rather than re-fetching on every single message in the conversation, to avoid unnecessary API calls and keep refinement responses fast.
- Clearly separate "Save" (keeps the trip editable/in-progress) from "Finalize Plan" (marks it complete) in the UI, per your requirement that refinement continues until the user is satisfied.
- This is explicitly a first version — keep the data model and API responses reasonably flexible (e.g., itinerary activities as a JSON array of objects with a consistent shape) so future features (booking integration, real accommodation search, multi-city trips) can be added without a full schema rewrite.
