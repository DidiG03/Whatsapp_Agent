import {
  evaluateSetupChecklist,
  SETUP_CHECKLIST_STEPS,
} from "../../src/services/setupChecklist.mjs";

describe("setupChecklist", () => {
  test("marks core steps from settings and counts", () => {
    const result = evaluateSetupChecklist(
      {
        business_name: "Acme Cafe",
        phone_number_id: "123456789012345",
        whatsapp_token: "token",
        conversation_mode: "escalation",
        bookings_enabled: false,
      },
      { kbCount: 2, staffCount: 0 }
    );

    expect(result.steps.map((s) => s.id)).toEqual(["business", "whatsapp", "knowledge_base"]);
    expect(result.completed).toBe(3);
    expect(result.allDone).toBe(true);
    expect(result.showChecklist).toBe(false);
  });

  test("includes staff step when bookings are enabled", () => {
    const result = evaluateSetupChecklist(
      {
        business_name: "Acme",
        conversation_mode: "full",
        bookings_enabled: true,
      },
      { kbCount: 0, staffCount: 0 }
    );

    expect(result.steps.some((s) => s.id === "staff")).toBe(true);
    expect(result.completed).toBe(1);
    expect(result.showChecklist).toBe(true);
  });

  test("exports stable step metadata", () => {
    expect(SETUP_CHECKLIST_STEPS.length).toBeGreaterThanOrEqual(3);
    expect(SETUP_CHECKLIST_STEPS[0]).toMatchObject({
      id: "business",
      href: "/settings#business",
    });
  });
});
