import { describe, test, expect, jest, beforeEach } from "@jest/globals";

const mockUpdateOne = jest.fn();
const mockFindOne = jest.fn(async () => null);

jest.mock("../../src/db-mongodb.mjs", () => ({
  db: {},
  getDB: () => ({
    collection: () => ({
      updateOne: (...args) => mockUpdateOne(...args),
      findOne: (...args) => mockFindOne(...args),
    }),
  }),
}));

jest.mock("../../src/schemas/mongodb.mjs", () => ({
  Customer: { findOne: jest.fn(() => ({ lean: async () => null })) },
}));

import { recordInboundMessage } from "../../src/services/messages.mjs";

const baseMessage = {
  messageId: "wamid.ABC123",
  userId: "tenant-1",
  from: "+355691112233",
  businessPhone: "+355690000000",
  type: "text",
  text: "Hello there",
  timestamp: 1700000000,
  raw: { id: "wamid.ABC123" },
};

describe("recordInboundMessage idempotency", () => {
  beforeEach(() => {
    mockUpdateOne.mockReset();
    mockFindOne.mockReset();
    mockFindOne.mockResolvedValue(null);
  });

  test("returns true only for a genuinely new message (upsert)", async () => {
    mockUpdateOne.mockResolvedValueOnce({ upsertedCount: 1, matchedCount: 0 });
    const result = await recordInboundMessage({ ...baseMessage });
    expect(result).toBe(true);
  });

  test("returns false for a duplicate Meta webhook delivery (matched, not inserted)", async () => {
    // First call: backfill text update path is allowed but must not flip the result.
    mockUpdateOne.mockResolvedValueOnce({ upsertedCount: 0, matchedCount: 1 });
    mockUpdateOne.mockResolvedValueOnce({ matchedCount: 1 });
    const result = await recordInboundMessage({ ...baseMessage });
    expect(result).toBe(false);
  });

  test("returns false when messageId or userId is missing", async () => {
    expect(await recordInboundMessage({ ...baseMessage, messageId: null })).toBe(false);
    expect(await recordInboundMessage({ ...baseMessage, userId: "" })).toBe(false);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});
