import { describe, expect, it } from "@jest/globals";
import { htmlToPlainText } from "../../src/services/websiteContext.mjs";
import { buildCoachSettingsContextBlock, buildCoachBusinessContext } from "../../src/services/coachContext.mjs";
import { buildGoogleBusinessCoachBlock } from "../../src/services/googleBusinessImport.mjs";

describe("websiteContext", () => {
  it("extracts title, description, and body text from html", () => {
    const html = `
      <html>
        <head>
          <title>Acme Spa</title>
          <meta name="description" content="Relaxing massages in Tirana." />
        </head>
        <body><h1>Welcome</h1><p>Book online today.</p></body>
      </html>
    `;
    const text = htmlToPlainText(html);
    expect(text).toContain("Acme Spa");
    expect(text).toContain("Relaxing massages in Tirana.");
    expect(text).toContain("Book online today.");
  });
});

describe("coachContext", () => {
  it("includes dashboard settings in coach business block", () => {
    const block = buildCoachSettingsContextBlock({
      business_name: "Acme Spa",
      business_type: "salon",
      website_url: "https://acme.example",
      business_phone: "+355 69 000 0000",
      ai_tone: "friendly",
      bookings_enabled: true,
    });
    expect(block).toContain("Acme Spa");
    expect(block).toContain("salon");
    expect(block).toContain("+355 69 000 0000");
    expect(block).toContain("friendly");
    expect(block).toContain("Bookings: enabled");
  });

  it("includes Google Business profile details for the coach", () => {
    const googleJson = JSON.stringify({
      syncedAt: "2024-06-15T12:00:00.000Z",
      profile: {
        name: "Ullishtja Agroturizëm",
        address: "Spitalle, Durrës",
        description: "Farm-to-table restaurant with local cuisine.",
        types: ["restaurant", "food"],
        rating: 4.8,
        ratingCount: 120,
        openingHours: { weekdayText: ["Monday: 9:00 AM – 10:00 PM", "Tuesday: 9:00 AM – 10:00 PM"] },
      },
    });
    const block = buildGoogleBusinessCoachBlock({ google_business_json: googleJson });
    expect(block).toContain("Ullishtja Agroturizëm");
    expect(block).toContain("Restaurant");
    expect(block).toContain("Monday: 9:00 AM");
    expect(block).toContain("4.8");
  });

  it("buildCoachBusinessContext combines settings, Google, and booking fields", async () => {
    const ctx = await buildCoachBusinessContext({
      business_name: "Ullishtja Agroturizëm",
      business_type: "Restaurant / Food",
      business_categories_json: JSON.stringify(["Restaurant"]),
      business_address: "Spitalle, Durrës",
      website_url: "",
      bookings_enabled: true,
      booking_fields_json: JSON.stringify({
        version: 2,
        profile: "restaurant",
        fields: [
          { id: "name", type: "name", label: "Name", required: true },
          { id: "party_size", type: "party_size", label: "Party size", required: true },
        ],
      }),
      google_business_json: JSON.stringify({
        syncedAt: "2024-06-15T12:00:00.000Z",
        profile: {
          name: "Ullishtja Agroturizëm",
          description: "Agrotourism restaurant.",
          types: ["restaurant"],
        },
      }),
    });
    expect(ctx).toContain("Ullishtja Agroturizëm");
    expect(ctx).toContain("Restaurant / Food");
    expect(ctx).toContain("Google Business Profile");
    expect(ctx).toContain("Party size");
  });

  it("buildCoachBusinessContext notes when bookings are disabled", async () => {
    const ctx = await buildCoachBusinessContext({
      business_name: "Acme Spa",
      bookings_enabled: false,
    });
    expect(ctx).toContain("Bookings: disabled");
    expect(ctx).toContain("inactive");
  });
});
