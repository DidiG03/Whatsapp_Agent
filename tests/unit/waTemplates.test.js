import { describe, expect, test } from "@jest/globals";
import {
  buildTemplateBodyComponents,
  buildTemplateDisplayText,
  buildTemplateNotFoundMessage,
  extractTemplateBodyAndVars,
  isTemplateTranslationError,
  languageFallbacks,
  orderMetaLanguages,
  orderTemplateLanguageCandidates,
} from "../../src/services/waTemplates.mjs";

describe("waTemplates", () => {
  test("extractTemplateBodyAndVars reads numbered placeholders", () => {
    const out = extractTemplateBodyAndVars({
      components: [{ type: "BODY", text: "Hi {{1}}. It has been {{2}} since we last spoke." }],
    });
    expect(out.indices).toEqual([1, 2]);
  });

  test("buildTemplateBodyComponents fills missing values with defaults", () => {
    const components = buildTemplateBodyComponents(
      { components: [{ type: "BODY", text: "Hi {{1}}. It has been {{2}} since we last spoke." }] },
      {},
      { 1: "Sefrid", 2: "a while" }
    );
    expect(components).toHaveLength(1);
    expect(components[0].parameters).toEqual([
      { type: "text", text: "Sefrid" },
      { type: "text", text: "a while" },
    ]);
  });

  test("languageFallbacks includes en and en_US", () => {
    expect(languageFallbacks("en")).toEqual(["en", "en_US"]);
    expect(languageFallbacks("en_US")).toEqual(["en_US", "en"]);
  });

  test("orderTemplateLanguageCandidates prefers configured and synced languages", () => {
    expect(orderTemplateLanguageCandidates("en", ["en_US"])).toEqual(["en", "en_US", "en_GB", "sq", "sq_AL"]);
  });

  test("isTemplateTranslationError detects Meta 132001", () => {
    expect(isTemplateTranslationError(new Error("WhatsApp error 400: (#132001) Template name does not exist in the translation"))).toBe(true);
    expect(isTemplateTranslationError(new Error("other"))).toBe(false);
  });

  test("orderMetaLanguages maps en to en_US when only Meta en_US exists", () => {
    expect(orderMetaLanguages("en", ["en_US"])).toEqual(["en_US"]);
    expect(orderMetaLanguages("en_US", ["en"])).toEqual(["en"]);
  });

  test("buildTemplateNotFoundMessage lists available templates", () => {
    const msg = buildTemplateNotFoundMessage("welcome_back", [
      { name: "hello_world", language: "en_US" },
    ]);
    expect(msg).toContain("welcome_back");
    expect(msg).toContain("hello_world (en_US)");
  });

  test("buildTemplateDisplayText fills placeholders for preview", () => {
    const text = buildTemplateDisplayText(
      { components: [{ type: "BODY", text: "Hi {{1}}. It has been {{2}}." }] },
      {},
      { 1: "Sefrid", 2: "a while" }
    );
    expect(text).toBe("Hi Sefrid. It has been a while.");
  });
});
