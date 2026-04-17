import { describe, expect, it } from "vitest";
import { createTranslator, translate, translateLiteralMessage } from "../i18n";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  parseAcceptLanguage,
  prefixLocalePath,
} from "../locale";

describe("locale helpers", () => {
  it("normalizes supported locale variants", () => {
    expect(normalizeLocale("fr-FR")).toBe("fr");
    expect(normalizeLocale("EN_us")).toBe("en");
    expect(normalizeLocale("  fr  ")).toBe("fr");
  });

  it("rejects unsupported locales", () => {
    expect(normalizeLocale("es")).toBeUndefined();
    expect(normalizeLocale("")).toBeUndefined();
    expect(normalizeLocale(undefined)).toBeUndefined();
  });

  it("parses accept-language by quality", () => {
    expect(parseAcceptLanguage("fr-FR;q=0.9,en-US;q=0.7")).toBe("fr");
    expect(parseAcceptLanguage("es-ES;q=0.9,en-US;q=0.7")).toBe("en");
    expect(parseAcceptLanguage(undefined)).toBeUndefined();
  });

  it("prefixes locale paths consistently", () => {
    expect(prefixLocalePath("fr", "/dashboard")).toBe("/fr/dashboard");
    expect(prefixLocalePath("en", "auth/login")).toBe("/en/auth/login");
    expect(prefixLocalePath("fr", "/")).toBe("/fr");
  });
});

describe("translations", () => {
  it("falls back to the default locale when locale is missing or unsupported", () => {
    expect(translate(undefined, "common.forbidden")).toBe("Forbidden");
    expect(translate("es", "common.forbidden")).toBe("Forbidden");
    expect(createTranslator("es")("common.notFound")).toBe("Not Found");
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("formats translated placeholders", () => {
    expect(translate("fr", "validation.tooSmall.string", { minimum: 8 })).toBe(
      "Doit contenir au moins 8 caracteres"
    );
  });

  it("maps known literal validation messages", () => {
    expect(translateLiteralMessage("fr", "Time must be in HH:mm format")).toBe(
      "L'heure doit etre au format HH:mm"
    );
    expect(translateLiteralMessage("fr", "Unknown message")).toBe(
      "Unknown message"
    );
  });
});
