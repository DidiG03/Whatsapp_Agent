import { describe, expect, it } from "@jest/globals";
import { htmlToPlainText } from "../../src/services/websiteContext.mjs";
import { buildCoachSettingsContextBlock } from "../../src/services/coachContext.mjs";

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
});
