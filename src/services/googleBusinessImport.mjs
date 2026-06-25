import { getRichPlaceDetails } from "./places.mjs";
import { upsertKbItem } from "./kb.mjs";

const GENERIC_TYPES = new Set([
  "establishment",
  "point_of_interest",
  "food",
  "store",
  "political",
  "locality",
  "sublocality",
  "sublocality_level_1",
  "neighborhood",
  "premise",
  "street_address",
  "route",
  "geocode",
]);

const TYPE_TO_BUSINESS = [
  [/restaurant|meal_takeaway|meal_delivery|cafe|bakery|bar/i, "Restaurant / Food"],
  [/store|shopping_mall|clothing_store|electronics_store|supermarket|grocery/i, "Retail / Ecommerce"],
  [/doctor|dentist|hospital|physiotherapist|health|spa|gym/i, "Health / Wellness"],
  [/lawyer|accounting|insurance_agency|finance|consulting/i, "Professional Services"],
  [/school|university|library/i, "Education"],
  [/real_estate_agency/i, "Real Estate"],
  [/car_dealer|car_repair|car_wash|gas_station/i, "Automotive"],
  [/beauty_salon|hair_care|nail_salon/i, "Beauty / Salon"],
  [/church|mosque|synagogue|hindu_temple|place_of_worship/i, "Nonprofit"],
];

function humanizeType(type) {
  return String(type || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function mapGoogleTypesToCategories(types = []) {
  return (types || [])
    .filter((t) => t && !GENERIC_TYPES.has(String(t)))
    .map(humanizeType)
    .slice(0, 12);
}

export function inferBusinessTypeFromGoogleTypes(types = []) {
  const joined = (types || []).join(" ");
  for (const [re, label] of TYPE_TO_BUSINESS) {
    if (re.test(joined)) return label;
  }
  return null;
}

function priceLevelLabel(level) {
  if (!Number.isFinite(level) || level <= 0) return null;
  return "$".repeat(Math.min(4, Math.max(1, level)));
}

export function formatOpeningHoursText(profile) {
  const lines = profile?.openingHours?.weekdayText || [];
  if (lines.length) return lines.join("\n");
  return null;
}

function buildAboutContent(profile) {
  const parts = [];
  if (profile.description) parts.push(profile.description);
  const cats = mapGoogleTypesToCategories(profile.types);
  if (cats.length) parts.push(`Categories: ${cats.join(", ")}.`);
  if (profile.rating != null) {
    const ratingLine = profile.ratingCount
      ? `Google rating: ${profile.rating} (${profile.ratingCount} reviews).`
      : `Google rating: ${profile.rating}.`;
    parts.push(ratingLine);
  }
  const price = priceLevelLabel(profile.priceLevel);
  if (price) parts.push(`Price level: ${price}.`);
  if (profile.businessStatus && profile.businessStatus !== "OPERATIONAL") {
    parts.push(`Status: ${humanizeType(profile.businessStatus)}.`);
  }
  return parts.join("\n\n").trim() || null;
}

function buildContactContent(profile) {
  const lines = [];
  if (profile.phone) lines.push(`Phone: ${profile.phone}`);
  if (profile.website) lines.push(`Website: ${profile.website}`);
  if (profile.mapsUrl) lines.push(`Google Maps: ${profile.mapsUrl}`);
  return lines.join("\n") || null;
}

function buildLocationContent(profile) {
  const lines = [];
  if (profile.address) lines.push(profile.address);
  else if (profile.vicinity) lines.push(profile.vicinity);
  if (profile.plusCode) lines.push(`Plus code: ${profile.plusCode}`);
  if (profile.mapsUrl) lines.push(`Directions: ${profile.mapsUrl}`);
  return lines.join("\n") || null;
}

function buildReviewsSummary(profile) {
  const reviews = Array.isArray(profile.reviews) ? profile.reviews : [];
  if (!reviews.length) return null;
  const lines = reviews.slice(0, 3).map((r) => {
    const head = [r.author, r.rating != null ? `${r.rating}/5` : null, r.relativeTime].filter(Boolean).join(" · ");
    return head ? `${head}: ${r.text || ""}`.trim() : (r.text || "");
  }).filter(Boolean);
  return lines.length ? lines.join("\n\n") : null;
}

function buildGoogleProfileKbContent(profile) {
  const sections = [];
  if (profile.name) sections.push(`Name: ${profile.name}`);
  if (profile.address) sections.push(`Address: ${profile.address}`);
  if (profile.phone) sections.push(`Phone: ${profile.phone}`);
  if (profile.website) sections.push(`Website: ${profile.website}`);
  const hours = formatOpeningHoursText(profile);
  if (hours) sections.push(`Hours:\n${hours}`);
  if (profile.description) sections.push(`About: ${profile.description}`);
  const cats = mapGoogleTypesToCategories(profile.types);
  if (cats.length) sections.push(`Categories: ${cats.join(", ")}`);
  if (profile.rating != null) {
    sections.push(`Rating: ${profile.rating}${profile.ratingCount ? ` (${profile.ratingCount} Google reviews)` : ""}`);
  }
  if (profile.mapsUrl) sections.push(`Maps: ${profile.mapsUrl}`);
  return sections.join("\n\n");
}

export function buildKbArticlesFromGoogleProfile(profile) {
  const articles = [];
  if (profile.name) {
    articles.push({ title: "Business Name", content: profile.name });
  }
  const about = buildAboutContent(profile);
  if (about) articles.push({ title: "About Us", content: about });
  const hours = formatOpeningHoursText(profile);
  if (hours) articles.push({ title: "Hours", content: hours });
  const contact = buildContactContent(profile);
  if (contact) articles.push({ title: "Contact", content: contact });
  const location = buildLocationContent(profile);
  if (location) articles.push({ title: "Location", content: location });
  const reviews = buildReviewsSummary(profile);
  if (reviews) articles.push({ title: "Customer Reviews", content: reviews });
  const full = buildGoogleProfileKbContent(profile);
  if (full) articles.push({ title: "Google Business Profile", content: full });
  return articles;
}

export function buildImportPreview(profile, currentSettings = {}) {
  const categories = mapGoogleTypesToCategories(profile.types);
  const inferredType = inferBusinessTypeFromGoogleTypes(profile.types);
  const kbArticles = buildKbArticlesFromGoogleProfile(profile);

  return {
    placeId: profile.placeId,
    name: profile.name,
    address: profile.address,
    phone: profile.phone,
    website: profile.website,
    mapsUrl: profile.mapsUrl,
    rating: profile.rating,
    ratingCount: profile.ratingCount,
    businessStatus: profile.businessStatus,
    priceLevel: priceLevelLabel(profile.priceLevel),
    description: profile.description,
    categories,
    inferredBusinessType: inferredType,
    openingHours: profile.openingHours?.weekdayText || [],
    reviewSnippetCount: (profile.reviews || []).length,
    kbArticles: kbArticles.map((a) => ({ title: a.title, preview: a.content.slice(0, 280) })),
    settingsUpdates: {
      business_name: profile.name || currentSettings.business_name || null,
      business_address: profile.address || currentSettings.business_address || null,
      business_latitude: profile.latitude,
      business_longitude: profile.longitude,
      business_place_id: profile.placeId,
      website_url: profile.website || currentSettings.website_url || null,
      business_type: inferredType || currentSettings.business_type || null,
      business_categories: categories.length ? categories : undefined,
    },
  };
}

export async function fetchGoogleBusinessProfile(placeId, options = {}) {
  return getRichPlaceDetails(placeId, { sessionToken: options.sessionToken });
}

export async function previewGoogleBusinessImport(userId, placeId, options = {}) {
  const { getSettingsForUser } = await import("./settings.mjs");
  const [profile, current] = await Promise.all([
    fetchGoogleBusinessProfile(placeId, options),
    getSettingsForUser(userId),
  ]);
  return buildImportPreview(profile, current);
}

export async function applyGoogleBusinessImport(userId, placeId, options = {}) {
  const { getSettingsForUser, upsertSettingsForUser } = await import("./settings.mjs");
  const profile = await fetchGoogleBusinessProfile(placeId, options);
  const current = await getSettingsForUser(userId);
  const preview = buildImportPreview(profile, current);
  const categories = mapGoogleTypesToCategories(profile.types);

  const snapshot = {
    syncedAt: new Date().toISOString(),
    placeId: profile.placeId,
    profile,
  };

  const settingsPatch = {
    business_name: profile.name || current.business_name || null,
    business_address: profile.address || current.business_address || null,
    business_latitude: profile.latitude,
    business_longitude: profile.longitude,
    business_place_id: profile.placeId,
    website_url: profile.website || current.website_url || null,
    business_type: preview.inferredBusinessType || current.business_type || null,
    business_categories_json: categories.length ? JSON.stringify(categories) : current.business_categories_json || null,
    google_business_json: JSON.stringify(snapshot),
  };

  await upsertSettingsForUser(userId, settingsPatch);

  const kbArticles = buildKbArticlesFromGoogleProfile(profile);
  const kbResults = [];
  for (const article of kbArticles) {
    const id = await upsertKbItem(userId, article.title, article.content);
    kbResults.push({ title: article.title, id, saved: !!id });
  }

  return {
    preview,
    kbResults,
    settingsPatch: {
      business_name: settingsPatch.business_name,
      business_address: settingsPatch.business_address,
      website_url: settingsPatch.website_url,
      business_type: settingsPatch.business_type,
    },
  };
}

export function parseGoogleBusinessSnapshot(cfg = {}) {
  try {
    const raw = cfg.google_business_json;
    if (!raw) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed?.profile || parsed || null;
  } catch {
    return null;
  }
}

export function buildGoogleBusinessCoachBlock(cfg = {}) {
  const profile = parseGoogleBusinessSnapshot(cfg);
  if (!profile) return null;

  const lines = [];
  if (profile.name) lines.push(`Name: ${profile.name}`);
  if (profile.address) lines.push(`Address: ${profile.address}`);
  if (profile.phone) lines.push(`Phone: ${profile.phone}`);
  if (profile.website) lines.push(`Website: ${profile.website}`);

  const types = mapGoogleTypesToCategories(profile.types);
  if (types.length) lines.push(`Place types: ${types.join(", ")}`);

  const inferred = inferBusinessTypeFromGoogleTypes(profile.types);
  if (inferred) lines.push(`Inferred business type: ${inferred}`);

  if (profile.description) {
    lines.push(`Description: ${String(profile.description).slice(0, 800)}`);
  }

  const hours = formatOpeningHoursText(profile);
  if (hours) lines.push(`Opening hours:\n${hours}`);

  if (profile.rating != null) {
    lines.push(
      `Rating: ${profile.rating}${profile.ratingCount ? ` (${profile.ratingCount} Google reviews)` : ""}`
    );
  }

  const price = priceLevelLabel(profile.priceLevel);
  if (price) lines.push(`Price level: ${price}`);

  if (profile.businessStatus && profile.businessStatus !== "OPERATIONAL") {
    lines.push(`Status: ${humanizeType(profile.businessStatus)}`);
  }

  if (profile.mapsUrl) lines.push(`Google Maps: ${profile.mapsUrl}`);

  const reviews = buildReviewsSummary(profile);
  if (reviews) lines.push(`Recent reviews:\n${reviews.slice(0, 900)}`);

  try {
    const snap = typeof cfg.google_business_json === "string" ? JSON.parse(cfg.google_business_json) : cfg.google_business_json;
    if (snap?.syncedAt) lines.push(`Last synced: ${String(snap.syncedAt).slice(0, 10)}`);
  } catch {}

  return lines.length ? lines.join("\n") : null;
}

export function buildGoogleBusinessContextLines(cfg = {}) {
  const profile = parseGoogleBusinessSnapshot(cfg);
  if (!profile) return [];
  const lines = [];
  if (profile.phone) lines.push(`Phone: ${profile.phone}`);
  const hours = formatOpeningHoursText(profile);
  if (hours) {
    const compact = profile.openingHours?.weekdayText?.slice(0, 3).join("; ");
    lines.push(compact ? `Hours (sample): ${compact}` : `Hours:\n${hours}`);
  }
  if (profile.description) lines.push(`About: ${profile.description.slice(0, 240)}`);
  if (profile.rating != null) {
    lines.push(`Google rating: ${profile.rating}${profile.ratingCount ? ` (${profile.ratingCount} reviews)` : ""}`);
  }
  if (profile.mapsUrl) lines.push(`Google Maps: ${profile.mapsUrl}`);
  return lines;
}
