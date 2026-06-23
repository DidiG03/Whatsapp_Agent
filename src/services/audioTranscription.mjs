import OpenAI, { toFile } from "openai";
import { downloadWhatsAppMedia, buildWaMediaProxyUrl } from "./whatsapp.mjs";
import { logHelpers } from "../monitoring/logger.mjs";

const MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1";
const WHISPER_PROMPT =
  "WhatsApp voice note. English or Albanian. Greetings, bookings, reservations, questions.";

let openaiClient = null;

function getOpenAI() {
  if (!openaiClient && String(process.env.OPENAI_API_KEY || "").trim()) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

export function isAudioTranscriptionEnabled() {
  const flag = String(process.env.AUDIO_TRANSCRIPTION_ENABLED ?? "1").toLowerCase();
  if (["0", "false", "off", "no"].includes(flag)) return false;
  return !!String(process.env.OPENAI_API_KEY || "").trim();
}

function whisperLanguageHint(lang) {
  const code = String(lang || "").trim().toLowerCase();
  if (!code || code === "auto") return undefined;
  if (code === "sq" || code.startsWith("sq-")) return "sq";
  if (code === "en" || code.startsWith("en-")) return "en";
  return code.slice(0, 2);
}

export function normalizeAudioMime(mime) {
  const base = String(mime || "audio/ogg").split(";")[0].trim().toLowerCase();
  if (base === "application/ogg") return "audio/ogg";
  return base || "audio/ogg";
}

function audioFileName(mimeType) {
  if (/mpeg|mp3/i.test(mimeType)) return "voice.mp3";
  if (/mp4|m4a|aac/i.test(mimeType)) return "voice.m4a";
  if (/wav/i.test(mimeType)) return "voice.wav";
  return "voice.ogg";
}

async function runWhisper(openai, file, { language } = {}) {
  return openai.audio.transcriptions.create({
    model: MODEL,
    file,
    response_format: "json",
    prompt: WHISPER_PROMPT,
    ...(language ? { language } : {}),
  });
}

export async function transcribeWhatsAppAudio({ mediaId, cfg, langHint } = {}) {
  if (!isAudioTranscriptionEnabled()) {
    return { text: "", skipped: true, reason: "disabled" };
  }
  const openai = getOpenAI();
  if (!openai) {
    return { text: "", skipped: true, reason: "no_openai_key" };
  }

  const started = Date.now();
  const { buffer, mimeType: rawMime } = await downloadWhatsAppMedia(mediaId, cfg);
  const mimeType = normalizeAudioMime(rawMime);
  const file = await toFile(buffer, audioFileName(mimeType), { type: mimeType });

  let result = await runWhisper(openai, file, {});
  let text = String(result?.text || "").trim();

  const hinted = whisperLanguageHint(langHint);
  if (!text && hinted) {
    result = await runWhisper(openai, file, { language: hinted });
    text = String(result?.text || "").trim();
  }

  logHelpers.logBusinessEvent("audio_transcribed", {
    media_id_tail: String(mediaId || "").slice(-8),
    duration_ms: Date.now() - started,
    text_len: text.length,
    language_hint: hinted || "auto",
    mime_type: mimeType,
  });

  return { text, language: hinted || result?.language || null };
}

export async function resolveInboundAudioText({ message, tenantUserId, from, cfg }) {
  const audio = message?.audio;
  if (!audio?.id || message?.type !== "audio") {
    return { text: "", mediaUrl: null, transcribed: false };
  }

  const mediaUrl = buildWaMediaProxyUrl(tenantUserId, audio.id);
  if (!isAudioTranscriptionEnabled()) {
    return { text: "", mediaUrl, transcribed: false };
  }

  let contactLangHint = null;
  try {
    const { getContactMemory } = await import("./memory.mjs");
    const mem = await getContactMemory(tenantUserId, from);
    contactLangHint = mem?.lang;
  } catch {}

  try {
    const trResult = await transcribeWhatsAppAudio({
      mediaId: audio.id,
      cfg,
      langHint: contactLangHint,
    });
    const text = String(trResult?.text || "").trim();
    return { text, mediaUrl, transcribed: !!text };
  } catch (audioErr) {
    console.warn("[Audio] transcription failed:", audioErr?.message || audioErr);
    logHelpers.logError(audioErr, { component: "audio_transcription", media_id_tail: String(audio.id).slice(-8) });
    return { text: "", mediaUrl, transcribed: false };
  }
}

export default {
  isAudioTranscriptionEnabled,
  normalizeAudioMime,
  transcribeWhatsAppAudio,
  resolveInboundAudioText,
};
