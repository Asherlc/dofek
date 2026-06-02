import { describe, expect, it } from "vitest";

describe("installIntlPolyfills", () => {
  it("installs NumberFormat formatToParts when the runtime does not provide it", async () => {
    const originalFormatToParts = Object.getOwnPropertyDescriptor(
      Intl.NumberFormat.prototype,
      "formatToParts",
    );
    Object.defineProperty(Intl.NumberFormat.prototype, "formatToParts", {
      configurable: true,
      value: undefined,
    });

    try {
      await import("./intl-polyfills.ts");

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
      if (originalFormatToParts) {
        Object.defineProperty(Intl.NumberFormat.prototype, "formatToParts", originalFormatToParts);
      }
    }
  });
});
