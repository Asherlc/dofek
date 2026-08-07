import { describe, expect, it, vi } from "vitest";

describe("installIntlPolyfills", () => {
  it("installs NumberFormat formatToParts when the runtime does not provide it", async () => {
    vi.resetModules();
    const originalNumberFormat = Object.getOwnPropertyDescriptor(Intl, "NumberFormat");
    const originalFormatToParts = Object.getOwnPropertyDescriptor(
      Intl.NumberFormat.prototype,
      "formatToParts",
    );
    Object.defineProperty(Intl.NumberFormat.prototype, "formatToParts", {
      configurable: true,
      value: undefined,
    });

    try {
      await import("./intl-polyfills.js");

      const parts = new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 0,
        minimumFractionDigits: 0,
        useGrouping: true,
      }).formatToParts(1999.6);

      expect(parts).toEqual([
        { type: "integer", value: "2" },
        { type: "group", value: "," },
        { type: "integer", value: "000" },
      ]);
    } finally {
      if (originalNumberFormat) {
        Object.defineProperty(Intl, "NumberFormat", originalNumberFormat);
      }
      if (originalFormatToParts) {
        Object.defineProperty(Intl.NumberFormat.prototype, "formatToParts", originalFormatToParts);
      }
    }
  });

  it("keeps native Intl implementations when they already exist", async () => {
    vi.resetModules();
    const originalGetCanonicalLocales = Object.getOwnPropertyDescriptor(
      Intl,
      "getCanonicalLocales",
    );
    const originalLocale = Object.getOwnPropertyDescriptor(Intl, "Locale");
    const originalNumberFormat = Object.getOwnPropertyDescriptor(Intl, "NumberFormat");
    const originalPluralRules = Object.getOwnPropertyDescriptor(Intl, "PluralRules");
    const nativeGetCanonicalLocales = Intl.getCanonicalLocales;
    const nativeLocale = Intl.Locale;
    const nativeNumberFormat = Intl.NumberFormat;
    const nativePluralRules = Intl.PluralRules;

    try {
      await import("./intl-polyfills.js");

      expect(Intl.getCanonicalLocales).toBe(nativeGetCanonicalLocales);
      expect(Intl.Locale).toBe(nativeLocale);
      expect(Intl.NumberFormat).toBe(nativeNumberFormat);
      expect(Intl.PluralRules).toBe(nativePluralRules);
    } finally {
      if (originalGetCanonicalLocales) {
        Object.defineProperty(Intl, "getCanonicalLocales", originalGetCanonicalLocales);
      }
      if (originalLocale) {
        Object.defineProperty(Intl, "Locale", originalLocale);
      }
      if (originalNumberFormat) {
        Object.defineProperty(Intl, "NumberFormat", originalNumberFormat);
      }
      if (originalPluralRules) {
        Object.defineProperty(Intl, "PluralRules", originalPluralRules);
      }
    }
  });
});
