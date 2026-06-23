/**
 * Lightweight bilingual (Albanian / English) helper.
 *
 * Goals:
 *  - detectLanguage(text): cheaply guess whether a customer is writing in
 *    Albanian ("sq") or English ("en") so we can reply in the same language.
 *  - languageInstruction(lang): a strong instruction we inject into LLM prompts
 *    so the model mirrors the customer's language and sounds human, not robotic.
 *  - t(key, lang, vars): localized versions of the canned/fallback strings the
 *    booking flow sends so the conversation never abruptly switches language.
 */

export const SUPPORTED_LANGS = ["sq", "en"];

// Albanian-only diacritics. Their presence is a very strong signal.
const ALBANIAN_DIACRITICS = /[ëçËÇ]/;

// Common Albanian words/markers. We keep these accent-insensitive so we still
// match when customers type "neser" instead of "nesër" etc.
const ALBANIAN_WORDS = [
  // greetings / pleasantries
  "pershendetje", "tungjatjeta", "tung", "miremengjes", "miredita", "mirembrema",
  "faleminderit", "flm", "ju lutem", "te lutem", "mire", "mirupafshim",
  // booking / scheduling
  "rezervo", "rezervim", "rezervoj", "termin", "takim", "orar", "orari",
  "cakto", "caktoj", "anulo", "anuloj", "anulim", "ndrysho", "ndryshoj",
  "konfirmo", "konfirmoj", "mbaje", "mbaj", "ruaje",
  "disponueshmeri", "i lire", "e lire", "vend", "vende",
  // time words
  "sot", "neser", "pasneser", "dje", "ora", "oren", "paradite", "pasdite",
  "mengjes", "mbremje", "nate", "jave", "javen", "muaj", "dite", "diten",
  // weekdays
  "hene", "marte", "merkure", "enjte", "premte", "shtune", "diel",
  // common verbs / pronouns / connectors
  "dua", "duan", "deshiroj", "mund", "kam", "kemi", "eshte", "jam", "je",
  "une", "ti", "ju", "ne", "per", "nje", "dhe", "edhe", "apo", "pse", "kur", "ku",
  "sa", "cfare", "cila", "cili", "si", "po", "jo", "me", "te", "nga",
  "persona", "personave", "veta", "fiks", "fix",
  // service / commerce
  "cmim", "cmimet", "kushton", "sa kushton", "porosi", "porosit", "produkt",
  "sherbim", "sherbime", "adresa", "ndihme", "njeri", "agjent", "operator",
];

const ALBANIAN_WORDS_SET = new Set(ALBANIAN_WORDS);

const ENGLISH_HINT_WORDS = new Set([
  "confirm", "yes", "keep", "cancel", "reschedule", "book", "booking",
  "tomorrow", "today", "thanks", "thank", "hello", "please", "sorry",
]);

function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Detect whether the message is Albanian ("sq") or English ("en").
 * Returns null when there is not enough signal (e.g. an emoji or a number),
 * so callers can fall back to a remembered/previous language.
 */
export function detectLanguage(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  // Strong, unambiguous signal: Albanian-specific letters.
  if (ALBANIAN_DIACRITICS.test(raw)) return "sq";

  const normalized = stripAccents(raw);
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  if (!tokens.length) return null; // emoji / punctuation / numbers only

  let albanianHits = 0;
  for (const tok of tokens) {
    if (ALBANIAN_WORDS_SET.has(tok)) albanianHits++;
  }

  // Multi-word phrases that strongly indicate Albanian.
  if (/\bsa kushton\b/.test(normalized)) albanianHits++;
  if (/\bdua te\b/.test(normalized)) albanianHits++;
  if (/\bju lutem\b/.test(normalized)) albanianHits++;

  if (albanianHits === 0) {
    const trimmed = raw.trim();
    if (/^[A-Za-zËÇëç][A-Za-zËÇëç'\-]+(?:\s+[A-Za-zËÇëç][A-Za-zËÇëç'\-]+){0,2}$/.test(trimmed)) {
      return null;
    }
    if (/^\d{1,2}(?::\d{2})?\s*(?:fiks|fix|sharp)?$/i.test(trimmed)) {
      return null;
    }
    if (tokens.length >= 2) return "en";
    if (tokens.length === 1 && ENGLISH_HINT_WORDS.has(tokens[0])) return "en";
    // Single short/ambiguous tokens ("konfirmo", "ok", a time) — keep remembered lang.
    return null;
  }

  // For very short messages a single Albanian hit is enough; for longer ones
  // require the Albanian words to be a meaningful share of the message.
  if (tokens.length <= 4) return albanianHits >= 1 ? "sq" : "en";
  const ratio = albanianHits / tokens.length;
  return ratio >= 0.18 || albanianHits >= 3 ? "sq" : "en";
}

/**
 * Resolve the language to use, given the current message and a previously
 * remembered preference. Short/ambiguous messages keep the remembered language.
 */
export function resolveLanguage(text, remembered, sessionLang) {
  const detected = detectLanguage(text);
  const raw = String(text || "").trim();
  const stickyName = /^[A-Za-zËÇëç][A-Za-zËÇëç'\-]+(?:\s+[A-Za-zËÇëç][A-Za-zËÇëç'\-]+){0,2}$/.test(raw);
  const stickyTime = /^\d{1,2}(?::\d{2})?\s*(?:fiks|fix|sharp)?$/i.test(raw)
    || /^(?:okej|ok|po)\b/i.test(raw);
  if (detected === "en" && remembered === "sq" && (stickyName || stickyTime)) {
    return "sq";
  }
  if (detected) return detected;
  if (sessionLang && SUPPORTED_LANGS.includes(sessionLang)) return sessionLang;
  if (remembered && SUPPORTED_LANGS.includes(remembered)) return remembered;
  return "en";
}

/**
 * Instruction injected into LLM system prompts so replies sound like a real,
 * native-speaking human and never mix languages.
 */
export function languageInstruction(lang) {
  if (lang === "sq") {
    return [
      "LANGUAGE: The customer is writing in Albanian (Shqip).",
      "Reply ONLY in natural, fluent, native Albanian, the way a friendly local employee would actually talk.",
      "Do not use the em dash character (—). Use commas, periods, or short sentences instead.",
      "Do not translate word-for-word from English and do not mix English words unless they are proper names or brand names.",
      "Use everyday, warm Albanian (e.g. 'Sigurisht!', 'Patjetër', 'Faleminderit', 'S'ka problem'). Avoid stiff or robotic phrasing.",
    ].join(" ");
  }
  return [
    "LANGUAGE: Reply in the same language the customer is using.",
    "If they write in Albanian, reply in fluent native Albanian; if in English, reply in English. Never mix languages within a reply.",
    "Sound like a warm, helpful human, not an automated bot.",
    "Do not use the em dash character (—). Use commas, periods, or short sentences instead.",
  ].join(" ");
}

/**
 * Expand an Albanian customer query with English KB search terms so token/FTS
 * search can match docs stored in English (hours, location, pricing, etc.).
 */
export function expandKbSearchQuery(query, lang) {
  const raw = String(query || "").trim();
  if (!raw || lang !== "sq") return raw;

  const normalized = stripAccents(raw);
  let expanded = ` ${normalized} `;

  const ALBANIAN_KB_EXPANSIONS = [
    [/\b(kur\s+jeni\s+hapur|kur\s+hapeni|kur\s+eshte\s+hapur|oraret?\s+e\s+hap(?:ura|ur)?|orari(?:n)?\s+e\s+punes?)\b/gi, " hours open opening schedule "],
    [/\b(hapur|hapeni|hapet|oraret|orari|orare)\b/gi, " hours open opening "],
    [/\b(mbyllur|mbylleni|mbyllet)\b/gi, " closed closing hours "],
    [/\b(dite(?:t|n)?\s+e\s+hap(?:ura|ur)?|ditet?\s+pun(?:e|es)?|kur\s+punoni)\b/gi, " opening days business days hours "],
    [/\b(adresa|adres|vendndodhje|ku\s+ndodheni|ku\s+jeni|ku\s+eshte)\b/gi, " location address directions "],
    [/\b(cmim(?:et)?|kushton|sa\s+kushton|pagesa)\b/gi, " pricing price payment cost "],
    [/\b(rezerv(?:im|o|oj)|termin(?:et)?|takim(?:et)?|cakto(?:j)?)\b/gi, " booking appointment reservation "],
    [/\b(anul(?:o|oj|im)|anulim)\b/gi, " cancel cancellation "],
    [/\b(disponuesh(?:meri|em)|i\s+lir[ea]|e\s+lir[ea]|vend(?:e)?)\b/gi, " availability available slots "],
    [/\b(menu|meny|ushqim|perberesit)\b/gi, " menu food dishes "],
    [/\b(dorezim|transport|poste)\b/gi, " delivery shipping pickup "],
    [/\b(kontakt|telefon|email|rikomando)\b/gi, " contact phone email "],
    [/\b(sherbim(?:e|et)?|oferta)\b/gi, " services "],
    [/\b(kthim|kthime|garanci)\b/gi, " returns warranty refund "],
    [/\b(wifi|wi\s*fi|internet|wireless)\b/gi, " wifi wi fi internet wireless "],
    [/\b(karta|krediti|kartat|debit|pranoni|pranoj|pranoni)\b/gi, " credit card payment payments accept cash debit "],
    [/\b(dorezim|dorezoni|transport)\b/gi, " delivery deliver shipping pickup "],
    [/\b(anglisht|anglis|english)\b/gi, " english menu "],
    [/\b(diel|te\s+diel|e\s+diel)\b/gi, " sunday open hours "],
    [/\b(emri|emrin|si\s+e\s+ka\s+emrin|quhet|si\s+quhet)\b.*\b(restorant|biznes|kompan|llogari|vendi)\b/gi, " business name company restaurant "],
    [/\b(me\s+ke\s+po\s+flas|kush\s+je|kush\s+jeni|identiteti|me\s+kem\s+po\s+flas)\b/gi, " who are you business name identity "],
    [/\b(restaurant\s+name|business\s+name|company\s+name|what\s+is\s+your\s+name|who\s+am\s+i\s+talking)\b/gi, " business name identity "],
    [/\b(cfare\s+(?:mund|me)\s+(?:te\s+)?(?:thuash|tregosh|tregon|ndihmon)|dua\s+te\s+di\s+me\s+shum|me\s+shum\s+rreth|cfare\s+(?:eshte|jane|jeni|keni)|kush\s+(?:jeni|jane)|prezantoni|prezantohu|interesohem\s+(?:per|rreth)|dua\s+te\s+njoh)\b/gi, " about us what we do google business profile hours location contact reviews rating "],
    [/\b(tell me (?:more )?about|what can you tell me|learn more about|who are you|about your business|about the business|what do you do|what is this place)\b/gi, " about us what we do google business profile hours location contact reviews "],
  ];

  for (const [re, rep] of ALBANIAN_KB_EXPANSIONS) {
    expanded = expanded.replace(re, ` ${rep} `);
  }

  return `${raw} ${expanded}`.replace(/\s+/g, " ").trim();
}

/** Keywords for cross-language KB scoring (Albanian query → English FAQ docs). */
export function extractKbSearchKeywords(query, lang) {
  const expanded = expandKbSearchQuery(query, lang);
  const norm = stripAccents(expanded).toLowerCase();
  const keywords = new Set();

  for (const tok of norm.split(/[^a-z0-9]+/).filter(Boolean)) {
    if (tok.length >= 2) keywords.add(tok);
  }

  const add = (...words) => {
    for (const w of words) if (w && w.length >= 2) keywords.add(w);
  };

  if (/\b(wifi|wi\s*fi|internet|wireless|wlan)\b/.test(norm)) {
    add("wifi", "wi", "fi", "internet", "wireless");
  }
  if (/\b(karta|krediti|kart|debit|pagesa|pages|pranoni|pranoj|accept|cash|apple|google)\b/.test(norm)) {
    add("credit", "card", "cards", "payment", "payments", "pay", "accept", "cash", "debit", "visa", "mastercard", "apple", "google");
  }
  if (/\b(dorezim|delivery|deliver|shipping|transport|pickup)\b/.test(norm)) {
    add("delivery", "deliver", "shipping", "pickup");
  }
  if (/\b(menu|meny|ushqim|english|anglisht|anglis)\b/.test(norm)) {
    add("menu", "english", "food");
  }
  if (/\b(diel|sunday|sun)\b/.test(norm)) {
    add("sunday", "open", "hours");
  }
  if (/\b(hapur|orar|orari|hours|open)\b/.test(norm)) {
    add("open", "hours", "hour");
  }

  return [...keywords];
}

/** Guidance for when KB docs do not contain an answer. */
export function kbScopeGuidance(lang) {
  const settingsRule = "Use the Business Settings block AND Docs (KB) for facts. Business Settings always includes the configured business name, type, categories, website, and services when present.";
  const identityRule = "When asked who they are talking to, the business/restaurant name, or what kind of business this is, answer directly from Business Settings.";
  const overviewRule = "When the customer asks a broad overview (tell me about you, I want to know more, who are you), synthesize a warm 3–5 sentence introduction from Business Settings plus Docs like About Us, Google Business Profile, Hours, Location, and What We Do — do NOT answer with a single narrow FAQ such as menu or payment unless they asked only about that.";
  const faqRule = "Docs (KB) are FAQ pairs: title = question, content = answer. They may be stored in English. Match the customer's message by MEANING — e.g. Albanian 'a ka wifi?' matches English 'Do you have wi fi', and 'a pranoni karta krediti?' matches 'Do you accept credit cards'. Use the matched Doc's content as the factual answer.";
  if (lang === "sq") {
    return [
      settingsRule,
      identityRule,
      overviewRule,
      faqRule,
      "When a Doc contains the answer, reply in natural Albanian using those facts — never say you lack the info just because the Doc is written in English.",
      "A Doc whose answer is just 'Yes' or 'No' IS a complete answer — expand it warmly in 2–3 sentences, not a telegraphic one-liner.",
      "Only if no Doc or Business Settings entry supports the answer, say briefly in Albanian that you do not have that information yet — never reply in English.",
    ].join(" ");
  }
  return [
    settingsRule,
    identityRule,
    overviewRule,
    faqRule,
    "If neither Business Settings nor Docs support a factual answer, say briefly that you do not have that information yet.",
  ].join(" ");
}

/** Broad "tell me about your business" questions — not a single narrow FAQ topic. */
export function isGeneralBusinessOverviewQuestion(text) {
  const s = stripAccents(String(text || "")).toLowerCase().trim();
  if (!s || s.length < 10) return false;
  if (/\b(menu|meny|orar|orari|oraret|adres|adresa|cmim|cmimet|wifi|wi fi|karta|krediti|rezerv|termin|takim|anul|delivery|dorezim)\b/.test(s)) {
    return false;
  }
  return (
    /\b(cfare\s+mund\s+te\s+me\s+thuash|cfare\s+(?:mund|me)\s+(?:te\s+)?(?:thuash|tregosh|tregon|ndihmon)|mund\s+(?:te\s+)?me\s+thuash|mund\s+tme\s+thuash|me\s+thuash\s+pak|pak\s+rreth|rreth\s+(?:restorantit|restaurantit|biznesit|vendit|kompanise|juaj))\b/.test(s)
    || /\b(dua\s+te\s+di\s+me\s+shum|me\s+shum\s+rreth|cfare\s+(?:eshte|jane|jeni|keni)|kush\s+(?:jeni|jane)|prezantoni|prezantohu|interesohem\s+(?:per|rreth)|dua\s+te\s+njoh)\b/.test(s)
    || /\b(tell me (?:more )?about|what can you tell me|learn more about|who are you|about your business|about the business|what do you do|what is this place)\b/.test(s)
  );
}

/** How the assistant should sound on WhatsApp — warm and human, not telegraphic. */
export function conversationalStyleGuidance(lang) {
  if (lang === "sq") {
    return [
      "Shkruaj si anëtar i vërtetë i ekipit në WhatsApp, i ngrohtë dhe attentiv, jo si bot FAQ.",
      "Mos përdor vizën e gjatë (—); përdor presje, pikë ose fjali të shkurtra.",
      "Përdor zakonisht 1–3 fjali natyrale: njoh pyetjen, jep përgjigjen, mbaro. Mos shto në fund 'nëse ju duhet ndihmë', 'më thuaj nëse dëshiron', 'këtu jam nëse...' ose oferta të ngjashme — PËRJASHTIM: kur klienti thotë se është mirë pas 'si jeni', duhet pyetje e dobishme; kur falenderon, kthe falenderimin.",
      "Pyet vetëm kur të mungon një informacion i nevojshëm për kërkesën e klientit (datë, orë, emër, etj.), jo si mbyllje e çdo mesazhi.",
      "Mos u tingëll telegrafik; lidh idetë natyrshëm dhe shmang përgjigjet e thata me një fjali.",
      "Mos e përsërit pyetjen word-for-word; mos shpik fakte jashtë Docs/KB.",
      "Një emoji e vetme me kujdes kur i përshtatet tonit.",
    ].join(" ");
  }
  return [
    "Write like a real team member on WhatsApp, warm and attentive, not a FAQ bot.",
    "Do not use em dashes (—); use commas, periods, or short sentences.",
    "Usually use 1–3 natural sentences: acknowledge, answer, stop. Do NOT end with 'let me know if you need anything else', 'I'm here if you need help', or similar boilerplate — EXCEPT after a wellbeing reply (ask how you can help) or thanks (reciprocate the thank-you).",
    "Only ask a question when you genuinely need missing info for their request, not as a closing line on every message.",
    "Avoid telegraphic one-liners; connect ideas naturally and avoid dry single-sentence replies.",
    "Don't repeat the question verbatim; never invent facts beyond the provided Docs/KB.",
    "At most one tasteful emoji when it fits the tone.",
  ].join(" ");
}

/** Detect a greeting anywhere in the customer's message. */
export function messageContainsGreeting(text) {
  const norm = stripAccents(String(text || "")).toLowerCase().replace(/\s+/g, " ").trim();
  if (!norm) return false;
  return /\b(pershendetje|përshëndetje|tungjatjeta|tung|hej|miremengjes|miredita|mirembrema|hello|hi|hey|howdy|hiya|good morning|good afternoon|good evening)\b/.test(norm)
    || /^(pershendetje|përshëndetje|tungjatjeta|tung|hej|miremengjes|miredita|mirembrema|hello|hi|hey)\b/.test(norm);
}

/** True when this reply should start with a warm greeting prefix. */
export function shouldPrefaceWithGreeting({
  lastInboundBeforeCurrentSec = null,
} = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const prevSec = lastInboundBeforeCurrentSec != null ? Number(lastInboundBeforeCurrentSec) : null;
  if (prevSec != null && (nowSec - prevSec) < 24 * 3600) return false;
  return true;
}

function replyAlreadyHasGreeting(reply, lang) {
  const norm = stripAccents(String(reply || "")).toLowerCase();
  if (lang === "sq") {
    return /^(pershendetje|përshëndetje|miremengjes|miredita|mirembrema|tungjatjeta|tung|hej)\b/.test(norm);
  }
  return /^(hello|hi|hey|good morning|good afternoon|good evening)\b/.test(norm);
}

export function buildSessionGreetingPrefix(lang, userMessage = "") {
  const norm = stripAccents(String(userMessage || "")).toLowerCase();
  if (lang === "sq") {
    if (/\bmiremengjes\b/.test(norm)) return "Mirëmëngjes!";
    if (/\bmiredita\b/.test(norm)) return "Mirëdita!";
    if (/\bmirembrema\b/.test(norm)) return "Mirëmbrëma!";
    return "Përshëndetje!";
  }
  if (/\bgood morning\b/.test(norm)) return "Good morning!";
  if (/\bgood afternoon\b/.test(norm)) return "Good afternoon!";
  if (/\bgood evening\b/.test(norm)) return "Good evening!";
  return "Hello!";
}

/** Prepend a short greeting when opening a fresh session reply. */
export function prependSessionGreeting(reply, lang, userMessage = "") {
  const body = String(reply || "").trim();
  if (!body) return body;
  if (replyAlreadyHasGreeting(body, lang)) return body;
  return `${buildSessionGreetingPrefix(lang, userMessage)} ${body}`;
}

/** Detect "how are you?" style pleasantries (not just hello). */
export function isHowAreYouQuestion(text) {
  const norm = stripAccents(String(text || "")).toLowerCase().replace(/\s+/g, " ").trim();
  if (!norm) return false;
  return /\b(si\s+jeni|ca\s+mande|si\s+kaloni|how\s+are\s+you|how\s+r\s+u|how\s+do\s+you\s+do|how\s+is\s+it\s+going|how'?s\s+it\s+going)\b/.test(norm);
}

export function howAreYouReplyGuidance(lang = "en") {
  if (lang === "sq") {
    return "If the customer asks how you are (e.g. 'si jeni', 'how are you'), reply warmly, say you're well, AND ask them back in one short phrase (e.g. 'Mirë, faleminderit! Po ju?' or 'Shumë mirë, faleminderit! Po ju?') — skipping the ask-back feels rude. Never say 'po jam këtu' or 'yes I'm here'.";
  }
  return "If the customer asks how you are, reply warmly, say you're well, AND ask them back briefly (e.g. 'We're well, thanks! And you?') — skipping the ask-back feels rude. Never say 'yes I'm here' or 'still here'.";
}

/** Customer says they are well after a how-are-you exchange (e.g. 'shum mirë'). */
export function isCustomerWellbeingReply(text) {
  const norm = stripAccents(String(text || "")).toLowerCase().replace(/\s+/g, " ").trim();
  if (!norm) return false;
  return /^(shume\s+mire|shum\s+mire|mire|mir[eë]|po\s+mire|ne\s+rregull|n[eë]\s+rregull|very\s+well|im\s+good|i'?m\s+fine|doing\s+(well|good|fine)|all\s+good|great\s+thanks?|good\s+thanks?)[!.?]*$/i.test(norm)
    || /^(mir[eë])(\s+faleminderit)?[!.?]*$/i.test(norm);
}

export function customerWellbeingReplyGuidance(lang = "en") {
  if (lang === "sq") {
    return "The customer just said they are well (e.g. 'shum mirë' after you asked how they are). Mirror briefly (e.g. 'Shumë mirë!') AND immediately ask what you can help with (e.g. 'Si mund t'ju ndihmoj sot?' or 'A dëshironi të rezervoni apo keni ndonjë pyetje?'). Never stop at 'Shumë mirë' alone — customers write to get something done.";
  }
  return "The customer said they are well after a how-are-you exchange. Acknowledge briefly AND ask what you can help with today — do not leave the conversation without a helpful follow-up.";
}

/** Standalone thank-you messages (e.g. 'flm', 'faleminderit', 'thanks'). */
export function isThankYouMessage(text) {
  const norm = stripAccents(String(text || "")).toLowerCase().replace(/\s+/g, " ").trim();
  if (!norm) return false;
  if (norm.length > 40) return false;
  return /^(faleminderit|flm|thanks?|thank\s+you|many\s+thanks|thx|tnx|rrofsh|cheers)(\s+(you|a\s+lot|so\s+much))?[!.?]*$/i.test(norm)
    || /^(ok\s+)?(faleminderit|flm|thanks?)[!.?]*$/i.test(norm);
}

export function thanksReplyGuidance(lang = "en") {
  if (lang === "sq") {
    return "The customer is thanking you. Reply with BOTH acknowledgment AND returned thanks (e.g. 'S'ka problem, faleminderit!' or 'Me kënaqësi, faleminderit!'). Never reply with only 'S'ka problem' — reciprocate the thanks.";
  }
  return "The customer is thanking you. Reply with something like 'You're welcome, thank you!' or 'No problem, thanks!' — not a bare 'No problem' alone.";
}

/** Tell the model not to re-introduce itself mid-conversation. */
export function conversationContinuityInstruction(conversationStarted, userMessageIsGreeting, userMessage = "") {
  const userHasGreeting = messageContainsGreeting(userMessage) && !userMessageIsGreeting;

  if (!conversationStarted) {
    return "If the customer opens with a greeting, greet back naturally when appropriate (e.g. 'Përshëndetje, si jeni?' / 'Hello, how are you?') — then help with their request. Never say 'po jam këtu', 'yes I'm here', or 'still here'.";
  }
  if (userMessageIsGreeting) {
    return "The customer sent another greeting mid-conversation. Reply with a natural greeting (e.g. 'Përshëndetje, si jeni?' / 'Hello again!') — NEVER say 'Po, jam këtu', 'Yes I'm here', or 'Still here'. If they have not stated a request yet, you may briefly ask how you can help.";
  }
  if (userHasGreeting) {
    return [
      "The customer's message includes a greeting AND a request (e.g. 'Përshëndetje, dua të rezervoj…').",
      "Start with a brief greeting (e.g. 'Përshëndetje!' / 'Hello!') then answer their request — never skip the greeting.",
      "When you give a complete answer, redirect, or policy reply, end with a short polite closing (e.g. 'Faleminderit!' / 'Thank you!').",
      "Never say 'po jam këtu' or 'yes I'm here'.",
    ].join(" ");
  }
  return [
    "CONTINUITY: This conversation is already in progress.",
    "Do NOT send a fresh 'how can I help you' intro or repeat a full welcome.",
    "Answer the latest question directly — stay warm and conversational, not robotic or one-word dry.",
    "When giving a complete answer or redirect, you may end with a brief 'Faleminderit!' / 'Thank you!' if it fits naturally.",
  ].join(" ");
}

const GREETING_ONLY_PATTERNS = [
  /^(pershendetje|përshëndetje|tungjatjeta|tung|hej|miremengjes|miredita|mirembrema|hello|hi|hey|good\s+(morning|afternoon|evening))[!.,\s]*(si\s+(mund\s+)?(t'?)?ju\s+ndihmoj|how\s+can\s+i\s+help(\s+you)?)?[!.?]*$/i,
  /^si\s+(mund\s+)?(t'?)?ju\s+ndihmoj[!.?]*$/i,
  /^how\s+can\s+i\s+help(\s+you)?[!.?]*$/i,
];

/** True when the whole reply is just a greeting / intro with no substance. */
export function isStandaloneGreeting(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  const norm = stripAccents(s).replace(/\s+/g, " ").trim();
  return GREETING_ONLY_PATTERNS.some((re) => re.test(norm));
}

/** Replace em/en dashes with natural WhatsApp punctuation. */
export function stripEmDashes(text) {
  let s = String(text || "");
  if (!/—/.test(s)) return s.trim();
  s = s.replace(/\s*—\s*/g, ", ");
  s = s.replace(/,\s*,+/g, ",");
  s = s.replace(/\s+,/g, ",");
  s = s.replace(/,\s*([.!?])/g, "$1");
  s = s.replace(/\s{2,}/g, " ");
  return s.trim();
}

/** Remove generic "anything else I can help with?" closers from bot replies. */
export function stripBoilerplateHelpOffers(text) {
  let s = String(text || "").trim();
  if (!s) return s;

  const trailingClosers = [
    /\s*[.!?]?\s*N[ëe]se\s+(doni|t[eë]\s+duhet|ju\s+duhet|d[ëe]shironi).*$/i,
    /\s*[.!?]?\s*Mund\s+t['']?ju\s+ndihmoj\s+(edhe\s+)?me\s+di[çc]ka\s+tjet[ëe]r.*$/i,
    /\s*[.!?]?\s*M[ëe]\s+thuaj\s+n[ëe]se\s+d[ëe]shiron.*$/i,
    /\s*[.!?]?\s*K[ëe]tu\s+jam\s+n[ëe]se.*$/i,
    /\s*[.!?]?\s*M[ëe]\s+shkruaj\s+pa\s+problem.*$/i,
    /\s*[.!?]?\s*Let\s+me\s+know\s+if\s+(you('d| would) like|you need).*$/i,
    /\s*[.!?]?\s*If\s+you\s+need\s+(anything\s+else|any\s+(help|assistance)).*$/i,
    /\s*[.!?]?\s*Feel\s+free\s+to\s+(reach\s+out|ask|write|message).*$/i,
    /\s*[.!?]?\s*I'?m\s+here\s+if\s+you\s+need.*$/i,
    /\s*[.!?]?\s*Is\s+there\s+anything\s+else.*$/i,
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const re of trailingClosers) {
      const next = s.replace(re, "").trim();
      if (next && next !== s) {
        s = next.replace(/[,;\s]+$/, "").trim();
        changed = true;
        break;
      }
    }
  }
  s = s
    .replace(/\s*K[ëe]tu\s+jam\s*$/i, "")
    .replace(/\s*I'?m\s+here\s*$/i, "")
    .replace(/[,;\s]+$/, "")
    .trim();
  return s;
}

/** Strip redundant greeting prefixes from AI replies in ongoing chats. */
export function sanitizeAssistantReply(text, { conversationStarted = false, userMessage = "", lang = "en" } = {}) {
  let s = String(text || "").trim();
  if (!s) return s;

  if (conversationStarted && !isStandaloneGreeting(userMessage)) {
    const prefixes = lang === "sq"
      ? [
          /^(pershendetje|përshëndetje|tungjatjeta|tung|hej|miremengjes|miredita|mirembrema)[!.,\s]+(si\s+(mund\s+)?(t'?)?ju\s+ndihmoj)[!.?]*\s+/i,
          /^si\s+(mund\s+)?(t'?)?ju\s+ndihmoj[!.?]*\s+/i,
        ]
      : [
          /^(hello|hi|hey|good\s+(morning|afternoon|evening))[!.,\s]+(how\s+can\s+i\s+help(\s+you)?)[!.?]*\s+/i,
          /^how\s+can\s+i\s+help(\s+you)?[!.?]*\s+/i,
        ];
    for (const re of prefixes) {
      const next = s.replace(re, "").trim();
      if (next && next !== s) {
        s = next;
        break;
      }
    }
  }

  s = stripBoilerplateHelpOffers(stripEmDashes(s.trim()));
  return polishPleasantryReply(s, { userMessage, lang });
}

function replyNeedsHelpFollowUp(reply, lang) {
  const norm = stripAccents(String(reply || "")).toLowerCase().trim();
  if (!norm) return true;
  if (/^(shume\s+mire|shum\s+mire|mire|mir[eë]|po\s+mire|ne\s+rregull|great|good|wonderful)[!.?]*$/.test(norm)) return true;
  if (/\b(si\s+(mund\s+)?(t'?)?ju\s+ndihmoj|how\s+can\s+i\s+help|a\s+deshironi|can\s+i\s+help)\b/.test(norm)) return false;
  return norm.length < 45 && !/\?/.test(norm);
}

function replyAlreadyHasThanksClosing(reply, lang) {
  const norm = stripAccents(String(reply || "")).toLowerCase();
  if (!norm) return false;
  if (lang === "sq") {
    return /\b(faleminderit|ju faleminderit|me kenaqesi)\b/.test(norm)
      && /[!.?]\s*$/.test(norm.trim());
  }
  return /\b(thank you|thanks|thank you!?)\b/.test(norm) && /[!.?]\s*$/.test(norm.trim());
}

function replyLooksLikeCompleteAnswer(reply, lang) {
  const norm = stripAccents(String(reply || "")).toLowerCase();
  if (norm.length < 50) return false;
  if (/\?\s*$/.test(norm) && !/\b(telefon|call|whatsapp)\b/.test(norm)) return false;
  return /\b(telefon|telefononi|na telefononi|call us|call directly|whatsapp|nuk e mbyllim|cannot complete|not complete|ju lutem)\b/.test(norm)
    || (norm.length >= 80 && !/\?\s*$/.test(norm));
}

/** Fix dry pleasantries: remove 'yes I'm here', enrich thanks, add help pivot after wellbeing. */
export function polishPleasantryReply(reply, { userMessage = "", lang = "en" } = {}) {
  let s = String(reply || "").trim();
  if (!s) return s;

  s = s
    .replace(/\b(po,?\s+)?jam\s+k[eë]tu\b/gi, "")
    .replace(/\b(yes,?\s+)?i'?m\s+here\b/gi, "")
    .replace(/\bstill\s+here[!.]?\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/([!.?])\s*([!.?])+$/g, "$1")
    .replace(/^[,.\s]+|[,.\s]+$/g, "")
    .trim();

  if (messageContainsGreeting(userMessage) && !replyAlreadyHasGreeting(s, lang)) {
    const prefix = buildSessionGreetingPrefix(lang, userMessage);
    s = `${prefix} ${s}`.trim();
  }

  if (isThankYouMessage(userMessage)) {
    const norm = stripAccents(s).toLowerCase();
    const bareThanksAckSq = /^(s'?ka\s+problem|ska\s+problem|pa\s+problem|s'?ka\s+gj[eë]|te\s+lutem)[!.?]*$/.test(norm);
    const bareThanksAckEn = /^(no\s+problem|you'?re\s+welcome|my\s+pleasure|anytime)[!.?]*$/.test(norm);
    if ((lang === "sq" && bareThanksAckSq) || (lang !== "sq" && bareThanksAckEn)) {
      s = lang === "sq" ? "S'ka problem, faleminderit!" : "No problem, thank you!";
    } else if (lang === "sq" && /^(s'?ka\s+problem|ska\s+problem|pa\s+problem)/.test(norm) && !/\bfaleminderit\b/.test(norm)) {
      s = s.replace(/[!.?]+$/, "") + ", faleminderit!";
    } else if (lang !== "sq" && /^no\s+problem\b/.test(norm) && !/\bthank\b/.test(norm)) {
      s = s.replace(/[!.?]+$/, "") + ", thank you!";
    }
  }

  if (isCustomerWellbeingReply(userMessage) && replyNeedsHelpFollowUp(s, lang)) {
    const followUp = lang === "sq" ? " Si mund t'ju ndihmoj sot?" : " How can I help you today?";
    if (!/\?/.test(s)) {
      s = s.replace(/[!.?]+$/, "") + "!" + followUp;
    }
  }

  if (
    !isThankYouMessage(userMessage)
    && !isCustomerWellbeingReply(userMessage)
    && replyLooksLikeCompleteAnswer(s, lang)
    && !replyAlreadyHasThanksClosing(s, lang)
  ) {
    s = s.replace(/[!.?]+$/, "") + (lang === "sq" ? ". Faleminderit!" : ". Thank you!");
  }

  return s.trim();
}

/** True when the assistant wrongly claims it lacks KB-backed facts. */
export function isKbMissReply(text, lang = "en") {
  const s = stripAccents(String(text || "")).toLowerCase();
  if (!s) return false;
  if (lang === "sq") {
    return /\b(nuk e kam|nuk kam|nuk e di|nuk mund te|nuk mund t)\b/.test(s)
      && /\b(informacion|info|te dhena|detaje)\b/.test(s);
  }
  return /\b(don't have|do not have|don't know|not have that|no information)\b/.test(s);
}

/** Simple FAQ-only messages (not booking / handoff). */
export function isLikelyFaqQuestion(text) {
  const s = stripAccents(String(text || "")).toLowerCase();
  if (!s || s.length < 3) return false;
  if (isLocationQuestion(text)) return true;
  if (/\b(rezerv|termin|takim|book|booking|cancel|anul|ndrysh|handoff|human|agent|availability)\b/.test(s)) {
    return false;
  }
  return /\?|^(a|a\s|a\s+ka|a\s+jeni|a\s+ofroni|a\s+pranoni|a\s+beni|ku|cfare|cila|si|kur|do you|are you|where|what|when|how|is there|can i|can we)\b/.test(s)
    || /\b(ka|keni|ofroni|pranoni|hapur|ndodheni|wifi|wi fi|karta|delivery|menu|orar)\b/.test(s);
}

/** Customer asking where the business is located (address / map pin). */
export function isLocationQuestion(text) {
  const s = stripAccents(String(text || "")).toLowerCase();
  if (!s || s.length < 3) return false;
  if (/\b(rezerv|booking|termin|takim|ref #|anul|cancel)\b/.test(s)) return false;
  return /\b(adresa|address|vendndodhja|lokacion|location|directions|harta|map|gps|pin)\b/.test(s)
    || /\b(ku ndodheni|ku jeni|ku eshte|ku te gjej|si te arrij|si te vij|how do i get|how to get|where are you|where is it|find you)\b/.test(s)
    || (/\b(ku|where)\b/.test(s) && /\b(jeni|ndodheni|gjeni|eshte|locat)\b/.test(s));
}

// ---------------------------------------------------------------------------
// Localized canned strings (fallbacks + deterministic booking copy).
// Values can be plain strings or functions of a `vars` object.
// ---------------------------------------------------------------------------
const STRINGS = {
  en: {
    ask_datetime: "Sure, what day and exact time work best for you? (e.g. \"tomorrow at 8pm\" or \"Nov 3 at 14:30\")",
    ask_specific_time: "What exact time works for you? (e.g. 8:30 PM or 21:00)",
    ask_range: "Of course! Which dates should I check? You can say \"tomorrow\", \"this week\", or \"Nov 3–5\".",
    no_times: "I don't see any open times for that. Want me to check another day or time of day?",
    past_time_warning: "That time has already passed 🙂 Could you share a future date and time? (e.g. \"today 4pm\" or \"tomorrow 14:30\")",
    closest_times: (v) => `That exact time isn't free, but I have these close by: ${(v?.suggestions || []).join(", ")}. Want one of these?`,
    confirm_booking: (v) => v?.when ? `Perfect! I've got you down for ${v.when}.` : "Perfect, I can book that for you.",
    booking_confirmed_ref: (v) => `You're all set${v?.when ? ` for ${v.when}` : ""}! Your reference is #${v?.ref}.`,
    book_offer: (v) => `Great, I can book ${v?.when}.`,
    slot_book_failed: "Sorry, that slot just got taken. Could you pick another time?",
    no_booking_found: "I couldn't find an upcoming booking under your number. Would you like to make a new one?",
    canceled: (v) => `Done. Your booking (Ref #${v?.ref}) has been canceled.`,
    rescheduled: (v) => `All set! I've moved your booking to ${v?.when} (Ref #${v?.ref}).`,
    booking_name_updated: (v) => `Done! I've updated the reservation name to ${v?.name} (Ref #${v?.ref}).`,
    ask_booking_new_name: "Sure — what name should I put on the reservation?",
    reschedule_request: "No problem, what new day and time would you like? (e.g. \"Friday at 2pm\")",
    cancel_confirm_instructions: (v) => `Just to confirm, reply "confirm" to cancel your booking (Ref #${v?.ref}), or "keep" to keep it.`,
    cancel_aborted: "No worries, I'll keep your booking as it is. Just say \"cancel\" anytime if that changes.",
    reset_done: "All good, I've reset the booking. Share a new date and time whenever you're ready.",
    waitlist_added: "Got it, I'll message you straight away if an earlier slot opens up. 👍",
    too_close: (v) => `That's a bit too close to the start time (within ${v?.minutes} min), so I can't change it automatically. Please contact us directly and we'll sort it out.`,
    handoff_ask_name: "Of course, I'll connect you with a colleague. Could I get your name first?",
    handoff_ask_reason: (v) => `Thanks${v?.name ? `, ${v.name}` : ""}! What's it regarding, so I can pass on the details?`,
    handoff_connecting: "Thanks! I'm connecting you with a member of our team now. 🙌",
    live_agent_connected: (v) => `You are connected with ${v?.name}.`,
    escalation_ack: "A member of our team will get back to you shortly.",
    escalation_reason_prompt: (v) => `Hello! What's the reason for contacting ${v?.business || "us"} today?`,
    error_generic: "Sorry, something went wrong on my side. Could you try again in a moment?",
    audio_transcription_failed: "I couldn't quite catch that voice message. Could you type your question or try recording again?",
    error_connecting_agent: "I'm having trouble connecting you to a colleague right now. Please try again in a moment.",
    available_times_header: "Here are some available times:",
    type_preferred_time: "Just write the time that works for you (e.g. \"9:30\" or \"21:30\").",
    availability_offer: (v) => {
      const period = v?.period ? ` ${v.period}` : "";
      const date = v?.date ? ` for ${v.date}` : "";
      return `Thanks for reaching out! I have a few open times${date}${period ? ` in the ${period}` : ""}. I'll share what's available. Write the time that suits you best.`;
    },
    choose_time: "Pick a time:",
    load_times_error: "Something went wrong loading the times. Could you pick a day again?",
    upcoming_bookings: (v) => `Here ${v?.many ? "are your upcoming bookings" : "is your upcoming booking"}:\n${v?.lines || ""}`,
    no_upcoming_booking: (v) => `I don't see an upcoming booking. Your last one was ${v?.when}${v?.meta ? ` (${v.meta})` : ""}.`,
    previous_agent: (v) => `Your previous agent was ${v?.name}.`,
    no_previous_agent: "I couldn't find a previous agent on record.",
    you_chose: (v) => `You chose ${v?.title}.`,
    add_to_calendar: "Add to your calendar:",
    location_reply_with_pin: (v) => `We're at ${v?.address || "this location"}. I'm sending the map pin now.`,
    location_text_only: (v) => `We're located at ${v?.address}.`,
    location_not_configured: "I don't have our address saved yet. Please check our website or ask a colleague for directions.",
    ref: (v) => `Ref #${v?.ref}`,
    pick_day_header: "Pick a day",
    pick_new_day_header: "Pick a new day",
    choose_date: "Choose a date:",
    choose_time: "Choose a time:",
    choose_new_time: "Choose a new time:",
    choose_service_header: "Choose a service",
    choose_service_body: "Select a service type:",
    select_button: "Select",
    earlier_slot_available: "An earlier slot is available. Choose a time:",
  },
  sq: {
    ask_datetime: "Sigurisht, cila ditë dhe cila orë saktësisht të përshtatet? (p.sh. \"nesër në orën 20:30\" ose \"3 nëntor në 14:30\")",
    ask_specific_time: "Cila orë saktësisht të përshtatet? (p.sh. 20:30 ose 21:00)",
    ask_range: "Patjetër! Cilat ditë t'i kontrolloj? Mund të thuash \"nesër\", \"këtë javë\", ose \"3–5 nëntor\".",
    no_times: "Nuk shoh orare të lira për atë kohë. Dëshiron të kontrolloj një ditë tjetër ose një pjesë tjetër të ditës?",
    past_time_warning: "Ajo orë ka kaluar tashmë 🙂 A mund të më japësh një datë dhe orë në të ardhmen? (p.sh. \"sot në 4pm\" ose \"nesër 14:30\")",
    closest_times: (v) => `Pikërisht ajo orë është e zënë, por kam këto afër: ${(v?.suggestions || []).join(", ")}. Të përshtatet ndonjëra?`,
    confirm_booking: (v) => v?.when ? `Perfekt! Të kam rezervuar për ${v.when}.` : "Perfekt, mund të ta rezervoj.",
    booking_confirmed_ref: (v) => `Gjithçka u krye${v?.when ? ` për ${v.when}` : ""}! Numri i referencës është #${v?.ref}.`,
    book_offer: (v) => `Shumë mirë, mund të rezervoj ${v?.when}.`,
    slot_book_failed: "Më vjen keq, ajo orë sapo u zu. A mund të zgjedhësh një orë tjetër?",
    no_booking_found: "Nuk gjeta ndonjë rezervim të ardhshëm me numrin tënd. Dëshiron të bësh një të ri?",
    canceled: (v) => `U krye. Rezervimi yt (Ref #${v?.ref}) u anulua.`,
    rescheduled: (v) => `Gjithçka u rregullua! E zhvendosa rezervimin tënd për ${v?.when} (Ref #${v?.ref}).`,
    booking_name_updated: (v) => `U krye! E përditësova emrin e rezervimit në ${v?.name} (Ref #${v?.ref}).`,
    ask_booking_new_name: "Sigurisht — me cilin emër ta ruaj rezervimin?",
    reschedule_request: "S'ka problem, për cilën ditë dhe orë të re dëshiron? (p.sh. \"të premten në orën 2\")",
    cancel_confirm_instructions: (v) => `Vetëm për konfirmim, shkruaj \"konfirmo\" për të anuluar rezervimin (Ref #${v?.ref}), ose \"mbaje\" për ta ruajtur.`,
    cancel_aborted: "S'ka problem, do ta ruaj rezervimin ashtu siç është. Thuaj \"anulo\" kurdo nëse ndryshon mendje.",
    reset_done: "Në rregull, e rivendosa rezervimin. Më jep një datë dhe orë të re kur të jesh gati.",
    waitlist_added: "U krye! Të shkruaj menjëherë nëse hapet një orar më i hershëm. 👍",
    too_close: (v) => `Është pak shumë afër orës së fillimit (brenda ${v?.minutes} min), prandaj nuk mund ta ndryshoj automatikisht. Të lutem na kontakto drejtpërdrejt dhe e rregullojmë.`,
    handoff_ask_name: "Sigurisht, të lidh me një koleg. A mund të ma thuash emrin tënd fillimisht?",
    handoff_ask_reason: (v) => `Faleminderit${v?.name ? `, ${v.name}` : ""}! Për çfarë bëhet fjalë, që t'ia përcjell detajet?`,
    handoff_connecting: "Faleminderit! Po të lidh tani me një anëtar të ekipit tonë. 🙌",
    live_agent_connected: (v) => `Je i lidhur tani me ${v?.name}.`,
    escalation_ack: "Një anëtar i ekipit tonë do të të kthejë përgjigje së shpejti.",
    escalation_reason_prompt: (v) => `Përshëndetje! Cila është arsyeja që po kontakton ${v?.business || "ne"} sot?`,
    error_generic: "Më vjen keq, diçka shkoi keq nga ana ime. A mund të provosh sërish pas pak?",
    audio_transcription_failed: "Nuk e kuptova mirë mesazhin zanor. A mund ta shkruash pyetjen ose ta regjistrosh përsëri?",
    error_connecting_agent: "Po has vështirësi për të të lidhur me një koleg tani. Të lutem provo sërish pas pak.",
    available_times_header: "Këto janë disa orare të lira:",
    type_preferred_time: "Shkruaj orën që të përshtatet (p.sh. \"9:30\" ose \"21:30\").",
    availability_offer: (v) => {
      const period = v?.period ? ` ${v.period}` : "";
      const date = v?.date ? ` për ${v.date}` : "";
      return `Faleminderit që na shkruajt! Kam disa orare të lira${date}${period ? ` ${period}` : ""}. Do t'i ndaj më poshtë. Shkruaj orën që të përshtatet.`;
    },
    choose_time: "Zgjidh një orë:",
    load_times_error: "Diçka shkoi keq gjatë ngarkimit të orareve. A mund të zgjedhësh sërish një ditë?",
    upcoming_bookings: (v) => `${v?.many ? "Këto janë rezervimet e tua të ardhshme" : "Ky është rezervimi yt i ardhshëm"}:\n${v?.lines || ""}`,
    no_upcoming_booking: (v) => `Nuk shoh ndonjë rezervim të ardhshëm. I fundit ishte ${v?.when}${v?.meta ? ` (${v.meta})` : ""}.`,
    previous_agent: (v) => `Agjenti yt i mëparshëm ishte ${v?.name}.`,
    no_previous_agent: "Nuk gjeta një agjent të mëparshëm në të dhëna.",
    you_chose: (v) => `Zgjodhe ${v?.title}.`,
    add_to_calendar: "Shtoje në kalendarin tënd:",
    location_reply_with_pin: (v) => `Jemi te ${v?.address || "kjo vendndodhje"}. Po ta dergoj tani vendndodhjen ne harte.`,
    location_text_only: (v) => `Ndodhemi te ${v?.address}.`,
    location_not_configured: "Nuk e kam te ruajtur adresen tone ende. Shiko faqen tone ose pyet nje koleg per udhezime.",
    ref: (v) => `Ref #${v?.ref}`,
    pick_day_header: "Zgjidh një ditë",
    pick_new_day_header: "Zgjidh një ditë të re",
    choose_date: "Zgjidh një datë:",
    choose_time: "Zgjidh një orë:",
    choose_new_time: "Zgjidh një orë të re:",
    choose_service_header: "Zgjidh një shërbim",
    choose_service_body: "Zgjidh llojin e shërbimit:",
    select_button: "Zgjidh",
    earlier_slot_available: "Ka një orar më të hershëm. Zgjidh një orë:",
  },
};

/**
 * Translate a canned-string key into the given language.
 * Falls back to English, then to the key itself, if missing.
 */
export function t(key, lang, vars = {}) {
  const l = SUPPORTED_LANGS.includes(lang) ? lang : "en";
  const table = STRINGS[l] || STRINGS.en;
  let entry = table[key];
  if (entry == null) entry = STRINGS.en[key];
  if (entry == null) return key;
  try {
    const out = typeof entry === "function" ? entry(vars || {}) : entry;
    return stripEmDashes(out);
  } catch {
    return typeof entry === "string" ? stripEmDashes(entry) : key;
  }
}
