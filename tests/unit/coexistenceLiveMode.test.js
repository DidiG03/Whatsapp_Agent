import { describe, expect, test, jest, beforeEach } from "@jest/globals";

jest.mock("../../src/db-mongodb.mjs", () => ({
  getDB: jest.fn(),
}));

jest.mock("../../src/services/handoff.mjs", () => ({
  upsertHandoffForContact: jest.fn(),
}));

jest.mock("../../src/services/conversationStatus.mjs", () => ({
  updateConversationStatus: jest.fn(),
  CONVERSATION_STATUSES: { IN_PROGRESS: "in_progress" },
}));

import { getDB } from "../../src/db-mongodb.mjs";
import { upsertHandoffForContact } from "../../src/services/handoff.mjs";
import {
  extractMessageEchoes,
  activateStaffLiveModeFromEcho,
  isCoexistenceAutoLiveEnabled,
} from "../../src/services/coexistenceLiveMode.mjs";

describe("extractMessageEchoes", () => {
  test("reads smb_message_echoes and message_echoes", () => {
    const echoes = extractMessageEchoes({
      smb_message_echoes: [{ id: "wamid.1", to: "35568123456", type: "text" }],
      message_echoes: [{ id: "wamid.2", to: "35568999999", type: "text" }],
    });
    expect(echoes).toHaveLength(2);
    expect(echoes.map((e) => e.source)).toEqual(["message_echoes", "smb_message_echoes"]);
  });
});

describe("activateStaffLiveModeFromEcho", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.COEXISTENCE_AUTO_LIVE_MODE = "1";
    process.env.COEXISTENCE_STAFF_LIVE_MINUTES = "30";
    getDB.mockReturnValue({
      collection: jest.fn(() => ({
        findOne: jest.fn().mockResolvedValue(null),
      })),
    });
  });

  test("activates live mode for smb_message_echoes", async () => {
    const result = await activateStaffLiveModeFromEcho({
      userId: "user-1",
      source: "smb_message_echoes",
      echo: {
        id: "wamid.staff1",
        to: "35568123456",
        from: "15556296064",
        type: "text",
        text: { body: "Hello from staff" },
      },
    });

    expect(result.activated).toBe(true);
    expect(result.customerPhone).toBe("35568123456");
    expect(upsertHandoffForContact).toHaveBeenCalledWith(
      "user-1",
      "35568123456",
      expect.objectContaining({ is_human: true })
    );
  });

  test("skips known API outbound echoes", async () => {
    getDB.mockReturnValue({
      collection: jest.fn(() => ({
        findOne: jest.fn().mockResolvedValue({ _id: "x" }),
      })),
    });

    const result = await activateStaffLiveModeFromEcho({
      userId: "user-1",
      source: "message_echoes",
      echo: { id: "wamid.bot1", to: "35568123456", type: "text" },
    });

    expect(result).toEqual({ activated: false, reason: "api_outbound" });
    expect(upsertHandoffForContact).not.toHaveBeenCalled();
  });

  test("respects disable flag", async () => {
    process.env.COEXISTENCE_AUTO_LIVE_MODE = "0";
    const result = await activateStaffLiveModeFromEcho({
      userId: "user-1",
      source: "smb_message_echoes",
      echo: { id: "wamid.staff1", to: "35568123456", type: "text" },
    });
    expect(result.reason).toBe("disabled");
  });
});

describe("isCoexistenceAutoLiveEnabled", () => {
  test("defaults to enabled", () => {
    delete process.env.COEXISTENCE_AUTO_LIVE_MODE;
    expect(isCoexistenceAutoLiveEnabled()).toBe(true);
  });
});
