import { describe, test, expect, beforeAll, beforeEach, afterEach } from "@jest/globals";

describe("audioTranscription", () => {
  let isAudioTranscriptionEnabled;
  let normalizeAudioMime;
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFlag = process.env.AUDIO_TRANSCRIPTION_ENABLED;

  beforeAll(async () => {
    ({ isAudioTranscriptionEnabled, normalizeAudioMime } = await import("../../src/services/audioTranscription.mjs"));
  });

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.AUDIO_TRANSCRIPTION_ENABLED = "1";
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalKey;
    process.env.AUDIO_TRANSCRIPTION_ENABLED = originalFlag;
  });

  test("isAudioTranscriptionEnabled respects flag and API key", () => {
    expect(isAudioTranscriptionEnabled()).toBe(true);
    process.env.AUDIO_TRANSCRIPTION_ENABLED = "0";
    expect(isAudioTranscriptionEnabled()).toBe(false);
    process.env.AUDIO_TRANSCRIPTION_ENABLED = "1";
    delete process.env.OPENAI_API_KEY;
    expect(isAudioTranscriptionEnabled()).toBe(false);
  });

  test("normalizeAudioMime strips codec suffix", () => {
    expect(normalizeAudioMime("audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(normalizeAudioMime("application/ogg")).toBe("audio/ogg");
  });
});
