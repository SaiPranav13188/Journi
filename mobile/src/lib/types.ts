// Shapes shared with the backend API (see backend/src/services/planner.js).

export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

export interface Destination {
  place_id: string;
  name: string;
  subtitle?: string;
  full_name?: string | null;
  country: string | null;
  country_code: string | null;
  latitude: number;
  longitude: number;
  currency_code: string | null;
  image_url?: string | null;
  type?: string | null;
}

export interface PlaceSearchResult extends Omit<Destination, 'latitude' | 'longitude'> {
  latitude: number | null;
  longitude: number | null;
}

export interface Activity {
  id: string;
  time_of_day: TimeOfDay;
  title: string;
  description: string;
  place_name: string | null;
  estimated_cost_inr: number;
  duration_hours: number | null;
  indoor: boolean;
  category: string;
  // Present when the activity was added from a chat suggestion:
  image_url?: string | null;
  rating?: number | null;
  rating_count?: number | null;
  rating_source?: 'google' | 'ai_estimate' | null;
  maps_url?: string | null;
  address?: string | null;
  source_suggestion_id?: string | null;
  /** Map position (filled in for the Map tab). */
  lat?: number | null;
  lng?: number | null;
  area?: string | null;
  /** Booked/confirmed by the traveller, or still just planned. */
  status?: 'planned' | 'confirmed';
  /** True for places the traveller added (from chat or by typing a name). */
  added_by_user?: boolean;
  /** An empty slot left behind after removing a place. */
  placeholder?: boolean;
  removed_title?: string | null;
}

/** A place card shown in chat (e.g. "coffee shops near my Day 1 plan"). */
export interface PlaceSuggestion {
  id: string;
  name: string;
  description: string;
  category: string;
  category_label?: string | null;
  address: string | null;
  rating: number | null;
  rating_count: number | null;
  /** 'google' = real Google Maps rating; 'ai_estimate' = approximate. */
  rating_source: 'google' | 'ai_estimate';
  price_label: string | null;
  image_url: string | null;
  maps_url: string | null;
  estimated_cost_inr: number;
  time_of_day: TimeOfDay;
}

export interface SuggestionsMetadata {
  type: 'suggestions';
  day_number: number;
  category: string;
  search_query: string;
  items: PlaceSuggestion[];
}

export interface MealSuggestion {
  dish: string;
  where: string | null;
  description: string;
  estimated_cost_inr: number;
}

export interface WeatherSummary {
  date: string;
  available: boolean;
  reason?: 'past' | 'beyond_forecast_range' | 'fetch_failed';
  weather_code?: number;
  condition?: string;
  icon?: 'sunny' | 'partly-cloudy' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'thunderstorm';
  temp_max?: number;
  temp_min?: number;
  precipitation_mm?: number;
  precipitation_probability?: number;
  wind_speed_max?: number;
  wind_gusts_max?: number;
  fetched_at?: string;
}

export interface ItineraryDay {
  id?: string;
  day_number: number;
  date: string;
  theme: string;
  activities: Activity[];
  meal_suggestion: MealSuggestion | null;
  accommodation_note: string | null;
  weather_summary: WeatherSummary | null;
  weather_warning: string | null;
}

export interface Budget {
  /** Return (up + down) flights per person, INR. Included in total_inr. */
  flights_estimate: number;
  flight_note: string | null;
  /** total_inr minus flights. */
  on_ground_inr: number;
  /** Cost of food places in the plan (cafés, restaurants) — included in food_estimate. */
  food_spots_inr?: number;
  accommodation_estimate: number;
  food_estimate: number;
  transport_estimate: number;
  activities_estimate: number;
  total_inr: number;
  total_local_currency: number | null;
  local_currency_code: string;
  exchange_rate_used: number | null;
  exchange_rate_timestamp: string | null;
  is_international: boolean;
  exchange_rate_provider?: string | null;
  nights: number;
  num_days: number;
  accommodation_per_night_inr: number;
  food_per_day_inr: number;
  local_transport_per_day_inr: number;
  notes?: string | null;
}

export type TripStatus = 'planning' | 'finalized';

export interface Trip {
  id: string | null;
  status: TripStatus;
  destination: Destination;
  /** City the traveller flies from (null for trips created before flights were added). */
  origin_city?: string | null;
  /** The traveller's own spending limit for the trip (INR). */
  budget_limit_inr?: number | null;
  start_date: string;
  end_date: string;
  num_days: number;
  created_at?: string;
  updated_at?: string;
}

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  metadata?: SuggestionsMetadata | null;
  pending?: boolean;
  failed?: boolean;
}

export interface TripPlan {
  trip: Trip;
  days: ItineraryDay[];
  budget: Budget | null;
  messages: ChatMessage[];
}

export interface PlanResponse extends TripPlan {
  reply: string;
  // ---- Agentic (v2) extras — absent on v1 responses ----
  /** Days whose content the agent changed (for the "Updated" badge). */
  updated_days?: number[];
  /** A question the planner needs answered before it can finish. */
  needs_clarification?: string | null;
  budget_delta?: { before: number | null; after: number | null; message: string | null } | null;
  budget_concern?: BudgetConcern | null;
  agent?: { runs: AgentRun[] };
}

/** Raised by the Budget agent when the total is >15% over the traveller's limit. */
export interface BudgetConcern {
  message: string;
  total: number;
  limit: number;
  over_pct: number;
}

/** What an agent did for a request (tools called, in order). */
export interface AgentRun {
  agent: string;
  run_id: string;
  steps: number;
  step_limit_reached: boolean;
  tool_calls: { step: number; tool: string; args: unknown; ok: boolean; duration_ms: number }[];
  model_calls: number;
  duration_ms: number;
}

export interface TripListItem extends Trip {
  id: string;
  summary: string;
  warning_count: number;
  total_inr: number | null;
  total_local_currency: number | null;
  local_currency_code: string;
}

export interface TripAlert {
  id: string;
  trip_id: string;
  day_number: number | null;
  kind: string;
  message: string;
  read: boolean;
  created_at: string;
  destination_name: string | null;
  /** Weather Watcher rework preview / severity / budget totals (v2). */
  metadata?: {
    severity?: 'low' | 'medium' | 'high';
    reason?: string;
    preview?: ReworkPreview;
  } | null;
}

export interface PlaceImage {
  url: string;
  width?: number;
  height?: number;
  source: string;
  attribution?: string;
}

// ---------------------------------------------------------------------------
// Dashboard, bookings, saved places
// ---------------------------------------------------------------------------

export interface CurrentWeather {
  current: {
    temp: number;
    feels_like: number;
    humidity: number;
    wind_speed: number;
    weather_code: number;
    condition: string;
    icon: WeatherSummary['icon'];
  };
  daily: {
    date: string;
    temp_max: number;
    temp_min: number;
    precipitation_probability: number | null;
    weather_code: number;
    condition: string;
    icon: WeatherSummary['icon'];
  }[];
}

export type BookingType = 'flight' | 'hotel' | 'train' | 'bus' | 'activity' | 'car' | 'other';
export type BookingStatus = 'confirmed' | 'pending' | 'cancelled';

export interface Booking {
  id: string;
  trip_id: string;
  type: BookingType;
  title: string;
  provider: string | null;
  confirmation_code: string | null;
  start_at: string | null;
  end_at: string | null;
  location: string | null;
  cost_inr: number;
  status: BookingStatus;
  notes: string | null;
  /** Uploaded ticket file (private storage path) and its original name. */
  ticket_path?: string | null;
  ticket_name?: string | null;
  created_at: string;
}

export type BookingInput = Omit<Booking, 'id' | 'created_at'>;

/** A booking read from an uploaded ticket, ready to fill the form. */
export interface ExtractedBooking {
  trip_id: string | null;
  type: BookingType;
  title: string;
  provider: string | null;
  confirmation_code: string | null;
  /** Local time as printed on the ticket, "YYYY-MM-DDTHH:mm". */
  start_local: string | null;
  end_local: string | null;
  location: string | null;
  cost_inr: number;
  status: BookingStatus;
  notes: string | null;
}

/** A ticket field the Ticket agent wasn't sure about — the traveller must confirm it. */
export interface TicketFieldFlag {
  field: string;
  value: string | null;
  reason: string;
}

export interface TicketExtractResult {
  bookings: ExtractedBooking[];
  ticket: { ticket_path: string; ticket_name: string } | null;
  // ---- Agentic (v2) ----
  summary?: string;
  /** Bookings the agent already saved (every field was clear). */
  saved?: Booking[];
  /** Bookings held back for the traveller to check, with the doubtful fields. */
  needs_confirmation?: { index: number; booking: ExtractedBooking; flags: TicketFieldFlag[] }[];
}

export interface SavedPlace {
  id: string;
  place_id: string | null;
  name: string;
  country: string | null;
  country_code: string | null;
  latitude: number | null;
  longitude: number | null;
  image_url: string | null;
  note: string | null;
  created_at: string;
}

export interface Dashboard {
  stats: { upcoming_trips: number; countries_visited: number; saved_places: number; total_trips: number };
  next_trip: (TripPlan & { weather: CurrentWeather | null; booked_inr: number }) | null;
  upcoming_trips: TripListItem[];
  saved_places: SavedPlace[];
}

// ---------------------------------------------------------------------------
// Travel tools
// ---------------------------------------------------------------------------

export interface ReworkTarget {
  day_number: number;
  instruction: string;
}

export interface ReworkPreview {
  reply: string;
  days: ItineraryDay[];
}

export interface PriceItem {
  name: string;
  price: number;
  price_inr: number | null;
  verdict: 'cheap' | 'fair' | 'high' | 'very_high' | 'unknown';
  typical_low: number | null;
  typical_high: number | null;
  typical_low_inr: number | null;
  typical_high_inr: number | null;
  note: string | null;
}

export interface PriceCheckResult {
  what: string | null;
  currency: string;
  rate: number | null;
  items: PriceItem[];
  summary: string | null;
  tip: string | null;
}

export interface PackingItem {
  id: string;
  name: string;
  reason: string | null;
  essential: boolean;
}

export interface PackingList {
  generated_at: string;
  categories: { name: string; items: PackingItem[] }[];
}
