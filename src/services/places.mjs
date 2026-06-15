import fetch from "node-fetch";

const RICH_PLACE_FIELDS = [
  "place_id",
  "name",
  "formatted_address",
  "geometry",
  "formatted_phone_number",
  "international_phone_number",
  "website",
  "opening_hours",
  "types",
  "url",
  "rating",
  "user_ratings_total",
  "business_status",
  "editorial_summary",
  "reviews",
  "price_level",
  "vicinity",
  "utc_offset",
  "plus_code",
].join(",");

export function isPlacesConfigured() {
  return !!String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
}

function mapsKey() {
  const key = String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY is not configured");
  return key;
}

export async function autocompleteAddress(input, { sessionToken } = {}) {
  const query = String(input || "").trim();
  if (query.length < 2) return [];

  const params = new URLSearchParams({
    input: query,
    key: mapsKey(),
    types: "establishment|geocode",
  });
  if (sessionToken) params.set("sessiontoken", String(sessionToken));

  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Places autocomplete failed (${resp.status}): ${body.slice(0, 300)}`);
  }

  const json = await resp.json();
  if (json.status === "ZERO_RESULTS") return [];
  if (json.status !== "OK" && json.status !== "INVALID_REQUEST") {
    throw new Error(`Places autocomplete error: ${json.status || "unknown"}`);
  }

  return (json.predictions || [])
    .map((p) => ({
      placeId: String(p.place_id || "").trim(),
      description: String(p.description || "").trim(),
      types: Array.isArray(p.types) ? p.types : [],
    }))
    .filter((p) => p.placeId && p.description)
    .slice(0, 8);
}

/** Business-focused autocomplete for Google Business import. */
export async function autocompleteBusiness(input, { sessionToken } = {}) {
  const query = String(input || "").trim();
  if (query.length < 2) return [];

  const params = new URLSearchParams({
    input: query,
    key: mapsKey(),
    types: "establishment",
  });
  if (sessionToken) params.set("sessiontoken", String(sessionToken));

  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Places business search failed (${resp.status}): ${body.slice(0, 300)}`);
  }

  const json = await resp.json();
  if (json.status === "ZERO_RESULTS") return [];
  if (json.status !== "OK" && json.status !== "INVALID_REQUEST") {
    throw new Error(`Places business search error: ${json.status || "unknown"}`);
  }

  return (json.predictions || [])
    .map((p) => ({
      placeId: String(p.place_id || "").trim(),
      description: String(p.description || "").trim(),
      mainText: String(p.structured_formatting?.main_text || "").trim(),
      secondaryText: String(p.structured_formatting?.secondary_text || "").trim(),
      types: Array.isArray(p.types) ? p.types : [],
    }))
    .filter((p) => p.placeId && p.description)
    .slice(0, 10);
}

function normalizePlaceResult(result, placeId) {
  const lat = Number(result?.geometry?.location?.lat);
  const lng = Number(result?.geometry?.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("Place has no coordinates");
  }

  const openingHours = result.opening_hours || null;
  const editorial = result.editorial_summary?.overview
    || result.editorial_summary?.description
    || null;

  const reviews = (Array.isArray(result.reviews) ? result.reviews : [])
    .slice(0, 5)
    .map((r) => ({
      author: String(r.author_name || "").trim() || null,
      rating: Number(r.rating) || null,
      text: String(r.text || "").trim().slice(0, 500) || null,
      relativeTime: String(r.relative_time_description || "").trim() || null,
    }))
    .filter((r) => r.text || r.rating);

  return {
    placeId: String(result.place_id || placeId),
    name: String(result.name || "").trim() || null,
    address: String(result.formatted_address || "").trim() || null,
    vicinity: String(result.vicinity || "").trim() || null,
    latitude: lat,
    longitude: lng,
    phone: String(result.formatted_phone_number || result.international_phone_number || "").trim() || null,
    website: String(result.website || "").trim() || null,
    mapsUrl: String(result.url || "").trim() || null,
    types: Array.isArray(result.types) ? result.types.map(String) : [],
    rating: Number.isFinite(Number(result.rating)) ? Number(result.rating) : null,
    ratingCount: Number.isFinite(Number(result.user_ratings_total)) ? Number(result.user_ratings_total) : null,
    businessStatus: String(result.business_status || "").trim() || null,
    priceLevel: Number.isFinite(Number(result.price_level)) ? Number(result.price_level) : null,
    utcOffsetMinutes: Number.isFinite(Number(result.utc_offset)) ? Number(result.utc_offset) : null,
    plusCode: String(result.plus_code?.global_code || result.plus_code?.compound_code || "").trim() || null,
    description: editorial ? String(editorial).trim() : null,
    openingHours: openingHours
      ? {
          openNow: openingHours.open_now === true,
          weekdayText: Array.isArray(openingHours.weekday_text)
            ? openingHours.weekday_text.map(String)
            : [],
          periods: Array.isArray(openingHours.periods) ? openingHours.periods : [],
        }
      : { openNow: null, weekdayText: [], periods: [] },
    reviews,
  };
}

export async function getPlaceDetails(placeId, { sessionToken } = {}) {
  const profile = await getRichPlaceDetails(placeId, { sessionToken });
  return {
    placeId: profile.placeId,
    name: profile.name,
    address: profile.address,
    latitude: profile.latitude,
    longitude: profile.longitude,
  };
}

export async function getRichPlaceDetails(placeId, { sessionToken } = {}) {
  const id = String(placeId || "").trim();
  if (!id) throw new Error("place_id is required");

  const params = new URLSearchParams({
    place_id: id,
    key: mapsKey(),
    fields: RICH_PLACE_FIELDS,
  });
  if (sessionToken) params.set("sessiontoken", String(sessionToken));

  const url = `https://maps.googleapis.com/maps/api/place/details/json?${params}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Places details failed (${resp.status}): ${body.slice(0, 300)}`);
  }

  const json = await resp.json();
  if (json.status !== "OK" || !json.result) {
    throw new Error(`Places details error: ${json.status || "unknown"}${json.error_message ? `: ${json.error_message}` : ""}`);
  }

  return normalizePlaceResult(json.result, id);
}
