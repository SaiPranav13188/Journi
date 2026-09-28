import { agenticAiEnabled } from './profile';
import { supabase } from './supabase';
import type {
  Booking,
  BookingInput,
  CurrentWeather,
  Dashboard,
  PackingList,
  PriceCheckResult,
  ReworkPreview,
  ReworkTarget,
  SavedPlace,
  TicketExtractResult,
  ExpenseCategory,
  GroupDetails,
  GroupExpense,
  GroupListItem,
  MemberPreferences,
  ChatMessage,
  Budget,
  Destination,
  ItineraryDay,
  PlaceImage,
  PlaceSuggestion,
  TimeOfDay,
  PlaceSearchResult,
  PlanResponse,
  TripAlert,
  TripListItem,
  TripPlan,
  TripStatus,
} from './types';

const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  auth?: boolean;
}

async function request<T>(path: string, { method = 'GET', body, timeoutMs = 30_000, signal, auth = true }: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new ApiError(401, 'Your session has expired. Please sign in again.');
    headers.Authorization = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  signal?.addEventListener('abort', () => controller.abort());

  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (res.status === 204) return undefined as T;
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, json?.error ?? `Request failed (${res.status})`);
    return json as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if ((err as Error).name === 'AbortError') {
      if (signal?.aborted) throw err;
      throw new ApiError(408, 'This is taking longer than expected. Please check your connection and try again.');
    }
    throw new ApiError(0, "Couldn't reach Journi. Check your internet connection and try again.");
  } finally {
    clearTimeout(timer);
  }
}

// AI calls can take a while — plus a Render free-tier cold start (up to ~1 min).
const AI_TIMEOUT = 120_000;
// Agent loops make several model calls per request.
const AGENT_TIMEOUT = 180_000;

/** Feature flag: route AI features through the agentic /v2 endpoints for this user. */
async function agentsEnabled(): Promise<boolean> {
  const { data } = await supabase.auth.getSession();
  return agenticAiEnabled(data.session?.user ?? null);
}

export const api = {
  /** Pings the server so a sleeping Render instance starts waking up early. */
  warmUp: () => request<{ status: string }>('/health', { auth: false, timeoutMs: 70_000 }).catch(() => null),

  searchPlaces: (q: string, signal?: AbortSignal) =>
    request<{ results: PlaceSearchResult[] }>(`/places/search?q=${encodeURIComponent(q)}`, { signal, timeoutMs: 60_000 }).then((r) => r.results),

  placeDetails: (placeId: string) =>
    request<{ place: Destination }>(`/places/details/${encodeURIComponent(placeId)}`).then((r) => r.place),

  placeImage: (query: string, width = 800) =>
    request<{ image: PlaceImage | null }>(`/places/image?query=${encodeURIComponent(query)}&width=${width}`).then((r) => r.image),

  generateItinerary: async (destination: Destination, originCity: string | null, startDate: string, endDate: string) => {
    const agents = await agentsEnabled();
    return request<PlanResponse>(agents ? '/v2/itinerary/generate' : '/itinerary/generate', {
      method: 'POST',
      body: { destination, origin_city: originCity, start_date: startDate, end_date: endDate },
      timeoutMs: agents ? AGENT_TIMEOUT : AI_TIMEOUT,
    });
  },

  /** Chat turn. With agentic AI on, the v2 Orchestrator decides which agents to run. */
  refineItinerary: async (params: {
    tripId: string | null;
    message: string;
    state?: Omit<TripPlan, 'messages'>;
    history?: ChatMessage[];
    focusDay?: number | null;
    /** Photo for the Orchestrator's price check (agentic chat only). */
    image?: { base64: string; mimeType: string } | null;
  }) => {
    const agents = await agentsEnabled();
    return request<PlanResponse>(agents ? '/v2/chat' : '/itinerary/refine', {
      method: 'POST',
      body: {
        trip_id: params.tripId,
        message: params.message,
        state: params.tripId ? undefined : params.state,
        history: params.tripId
          ? undefined
          : params.history?.map(({ role, content, created_at, metadata }) => ({ role, content, created_at, metadata })),
        focus_day: params.focusDay ?? null,
        ...(agents && params.image ? { image: { base64: params.image.base64, mime_type: params.image.mimeType } } : {}),
      },
      timeoutMs: agents ? AGENT_TIMEOUT : AI_TIMEOUT,
    });
  },

  /** Adds a suggested place to a day; returns the updated days and budget. */
  addActivity: (params: {
    tripId: string | null;
    dayNumber: number;
    suggestion: PlaceSuggestion;
    timeOfDay: TimeOfDay;
    state?: Omit<TripPlan, 'messages'>;
  }) =>
    request<{ days: ItineraryDay[]; budget: Budget }>('/itinerary/add-activity', {
      method: 'POST',
      body: {
        trip_id: params.tripId,
        day_number: params.dayNumber,
        suggestion: params.suggestion,
        time_of_day: params.timeOfDay,
        state: params.tripId ? undefined : params.state,
      },
    }),

  /** Removes a place (leaves an empty slot) or deletes an empty slot. */
  removeActivity: (params: { tripId: string | null; dayNumber: number; activityId: string; state?: Omit<TripPlan, 'messages'> }) =>
    request<{ days: ItineraryDay[]; budget: Budget }>('/itinerary/remove-activity', {
      method: 'POST',
      body: {
        trip_id: params.tripId,
        day_number: params.dayNumber,
        activity_id: params.activityId,
        state: params.tripId ? undefined : params.state,
      },
    }),

  /** Looks up a typed place name and puts it into an empty slot. */
  fillSlot: (params: { tripId: string | null; dayNumber: number; activityId: string; query: string; state?: Omit<TripPlan, 'messages'> }) =>
    request<{ days: ItineraryDay[]; budget: Budget }>('/itinerary/fill-slot', {
      method: 'POST',
      body: {
        trip_id: params.tripId,
        day_number: params.dayNumber,
        activity_id: params.activityId,
        query: params.query,
        state: params.tripId ? undefined : params.state,
      },
      timeoutMs: 90_000,
    }),

  // ---- dashboard & extras -------------------------------------------------
  dashboard: () => request<Dashboard>('/dashboard', { timeoutMs: 70_000 }),
  weather: (lat: number, lon: number) =>
    request<{ weather: CurrentWeather }>(`/weather?lat=${lat}&lon=${lon}`).then((r) => r.weather),

  savedPlaces: () => request<{ places: SavedPlace[] }>('/saved-places').then((r) => r.places),
  savePlace: (place: Partial<SavedPlace> & { name: string }) =>
    request<{ place: SavedPlace }>('/saved-places', { method: 'POST', body: place }).then((r) => r.place),
  removeSavedPlace: (id: string) => request<void>(`/saved-places/${id}`, { method: 'DELETE' }),

  bookings: (tripId?: string) =>
    request<{ bookings: Booking[] }>(`/bookings${tripId ? `?trip_id=${tripId}` : ''}`).then((r) => r.bookings),
  createBooking: (b: BookingInput) => request<{ booking: Booking }>('/bookings', { method: 'POST', body: b }).then((r) => r.booking),
  updateBooking: (id: string, b: Partial<BookingInput>) =>
    request<{ booking: Booking }>(`/bookings/${id}`, { method: 'PATCH', body: b }).then((r) => r.booking),
  /** Reads a ticket (photo or PDF) and returns the booking(s) in it; the file is kept for attaching. */
  /** With agentic AI on, clear bookings are saved right away and doubtful ones come back to confirm. */
  extractTicket: async (file: { base64: string; mimeType: string; name?: string | null; typeHint?: string | null }) => {
    const agents = await agentsEnabled();
    return request<TicketExtractResult>(agents ? '/v2/bookings/extract' : '/bookings/extract', {
      method: 'POST',
      body: {
        file_base64: file.base64,
        mime_type: file.mimeType,
        file_name: file.name ?? null,
        type_hint: file.typeHint ?? null,
        ...(agents ? { tz_offset_minutes: new Date().getTimezoneOffset() } : {}),
      },
      timeoutMs: agents ? AGENT_TIMEOUT : 120_000,
    });
  },
  /** Short-lived link to view a booking's attached ticket. */
  ticketUrl: (bookingId: string) => request<{ url: string; name: string | null }>(`/bookings/${bookingId}/ticket`),
  deleteBooking: (id: string) => request<void>(`/bookings/${id}`, { method: 'DELETE' }),

  setBudgetLimit: (tripId: string, limit: number | null) =>
    request<TripPlan>(`/trips/${tripId}`, { method: 'PATCH', body: { budget_limit_inr: limit } }),

  /** Adds map coordinates to itinerary places (slow the first time — up to ~30s). */
  geocode: (params: { tripId: string | null; state?: Omit<TripPlan, 'messages'> }) =>
    request<{ days: ItineraryDay[] }>('/itinerary/geocode', {
      method: 'POST',
      body: { trip_id: params.tripId, state: params.tripId ? undefined : params.state },
      timeoutMs: 90_000,
    }),

  /** Flight cost typed in by the traveller (null/0 clears it); returns the updated budget. */
  setFlightCost: (params: { tripId: string | null; amountInr: number | null; state?: Omit<TripPlan, 'messages'> }) =>
    request<{ days: ItineraryDay[]; budget: Budget }>('/itinerary/flight-cost', {
      method: 'POST',
      body: { trip_id: params.tripId, amount_inr: params.amountInr, state: params.tripId ? undefined : params.state },
    }),

  setActivityStatus: (params: {
    tripId: string | null;
    dayNumber: number;
    activityId: string;
    status: 'planned' | 'confirmed';
    state?: Omit<TripPlan, 'messages'>;
  }) =>
    request<{ days: ItineraryDay[]; budget: Budget }>('/itinerary/activity-status', {
      method: 'POST',
      body: {
        trip_id: params.tripId,
        day_number: params.dayNumber,
        activity_id: params.activityId,
        status: params.status,
        state: params.tripId ? undefined : params.state,
      },
    }),

  /** Proposes new versions of days (rain swap / flight-aware). Nothing is saved. */
  reworkPreview: (params: { tripId: string | null; targets: ReworkTarget[]; state?: Omit<TripPlan, 'messages'> }) =>
    request<ReworkPreview>('/itinerary/rework-preview', {
      method: 'POST',
      body: { trip_id: params.tripId, targets: params.targets, state: params.tripId ? undefined : params.state },
      timeoutMs: 90_000,
    }),
  /** Applies previewed days ("Swap plan"). */
  applyDays: (params: { tripId: string | null; days: ItineraryDay[]; state?: Omit<TripPlan, 'messages'> }) =>
    request<{ days: ItineraryDay[]; budget: Budget }>('/itinerary/apply-days', {
      method: 'POST',
      body: { trip_id: params.tripId, days: params.days, state: params.tripId ? undefined : params.state },
    }),
  packingList: (params: { tripId: string | null; state?: Omit<TripPlan, 'messages'> }) =>
    request<PackingList>('/itinerary/packing-list', {
      method: 'POST',
      body: { trip_id: params.tripId, state: params.tripId ? undefined : params.state },
      timeoutMs: 90_000,
    }),
  /** Photo of prices → fair / high verdicts in ₹. */
  priceCheck: async (params: { base64: string; mimeType: string; place: string; countryCode?: string | null; note?: string | null }) => {
    const agents = await agentsEnabled();
    return request<PriceCheckResult>(agents ? '/v2/tools/price-check' : '/tools/price-check', {
      method: 'POST',
      body: {
        image_base64: params.base64,
        mime_type: params.mimeType,
        place: params.place,
        country_code: params.countryCode ?? null,
        note: params.note ?? null,
      },
      timeoutMs: agents ? AGENT_TIMEOUT : 90_000,
    });
  },

  listTrips: () => request<{ trips: TripListItem[] }>('/trips', { timeoutMs: 70_000 }).then((r) => r.trips),
  getTrip: (id: string) => request<TripPlan>(`/trips/${id}`, { timeoutMs: 70_000 }),
  createTrip: (plan: TripPlan) => request<TripPlan>('/trips', { method: 'POST', body: plan }),
  updateTrip: (id: string, plan: Omit<TripPlan, 'messages'>) =>
    request<TripPlan>(`/trips/${id}`, { method: 'PUT', body: { trip: plan.trip, days: plan.days, budget: plan.budget } }),
  setTripStatus: (id: string, status: TripStatus) => request<TripPlan>(`/trips/${id}`, { method: 'PATCH', body: { status } }),
  updateAccommodation: (id: string, dayNumber: number, note: string | null) =>
    request<{ ok: true }>(`/trips/${id}/days/${dayNumber}`, { method: 'PATCH', body: { accommodation_note: note } }),
  deleteTrip: (id: string) => request<void>(`/trips/${id}`, { method: 'DELETE' }),

  // ---- group trips (always agentic) ------------------------------------------
  groups: {
    list: () => request<{ groups: GroupListItem[] }>('/v2/groups', { timeoutMs: 70_000 }).then((r) => r.groups),
    /** Shares one of my saved trips with a group (creates its join code). */
    create: (tripId: string) => request<GroupDetails>('/v2/groups', { method: 'POST', body: { trip_id: tripId } }),
    join: (code: string) =>
      request<{ trip_id: string; destination_name: string; already_member: boolean }>('/v2/groups/join', { method: 'POST', body: { code } }),
    get: (tripId: string) => request<GroupDetails>(`/v2/groups/${tripId}`, { timeoutMs: 70_000 }),
    /** A group-chat turn handled by the Group agent. */
    chat: (tripId: string, message: string) =>
      request<PlanResponse>(`/v2/groups/${tripId}/chat`, { method: 'POST', body: { message }, timeoutMs: AGENT_TIMEOUT }),
    savePreferences: (tripId: string, prefs: MemberPreferences) =>
      request<{ preferences: MemberPreferences }>(`/v2/groups/${tripId}/preferences`, { method: 'PUT', body: prefs }).then((r) => r.preferences),
    vote: (tripId: string, pollId: string, optionId: string) =>
      request<{ ok: true; closed: boolean }>(`/v2/groups/${tripId}/polls/${pollId}/vote`, { method: 'POST', body: { option_id: optionId } }),
    closePoll: (tripId: string, pollId: string) => request<{ ok: true }>(`/v2/groups/${tripId}/polls/${pollId}/close`, { method: 'POST' }),
    addExpense: (
      tripId: string,
      e: { description: string; amount_inr: number; paid_by: string; split_among: string[] | null; category: ExpenseCategory },
    ) => request<{ expense: GroupExpense }>(`/v2/groups/${tripId}/expenses`, { method: 'POST', body: e }).then((r) => r.expense),
    deleteExpense: (tripId: string, expenseId: string) => request<void>(`/v2/groups/${tripId}/expenses/${expenseId}`, { method: 'DELETE' }),
    /** Leave (your own id) or remove someone (organiser only). */
    removeMember: (tripId: string, userId: string) => request<unknown>(`/v2/groups/${tripId}/members/${userId}`, { method: 'DELETE' }),
  },

  listAlerts: (unreadOnly = false) =>
    request<{ alerts: TripAlert[] }>(`/alerts${unreadOnly ? '?unread=1' : ''}`).then((r) => r.alerts),
  markAlertsRead: (ids?: string[]) => request<{ ok: true }>('/alerts/read', { method: 'POST', body: { ids } }),
};
