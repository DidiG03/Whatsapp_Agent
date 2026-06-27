import { describe, expect, test, jest, beforeEach } from "@jest/globals";

const mockDeleteMany = jest.fn(async () => ({ deletedCount: 1 }));
const mockUpdateMany = jest.fn(async () => ({ modifiedCount: 1 }));

jest.mock("../../src/db-mongodb.mjs", () => ({
  getDB: () => ({
    collection: () => ({
      deleteMany: mockDeleteMany,
      updateMany: mockUpdateMany,
    }),
  }),
}));

import { resetContactBotKnowledge } from "../../src/services/contactReset.mjs";

describe("contactReset", () => {
  beforeEach(() => {
    mockDeleteMany.mockClear();
    mockUpdateMany.mockClear();
  });

  test("resetContactBotKnowledge wipes bot memory collections for contact variants", async () => {
    const result = await resetContactBotKnowledge("user-1", "+447700900123");
    expect(result.ok).toBe(true);
    expect(mockDeleteMany.mock.calls.length).toBeGreaterThan(5);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const deletedCollections = mockDeleteMany.mock.calls.map(([query]) => query);
    expect(deletedCollections.some((q) => q.user_id === "user-1" && q.contact_id?.$in)).toBe(true);
  });

  test("resetContactBotKnowledge no-ops without user or phone", async () => {
    const result = await resetContactBotKnowledge(null, "+123");
    expect(result.ok).toBe(false);
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });
});
