import { describe, expect, it, vi } from "vitest";
import { createAdaptiveColors, darkColors, lightColors } from "./theme-palette";

function relativeLuminance(hexColor: string): number {
  const linearChannel = (start: number) => {
    const channel = Number.parseInt(hexColor.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearChannel(1) + 0.7152 * linearChannel(3) + 0.0722 * linearChannel(5);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("mobile semantic color palettes", () => {
  it("preserves the existing light appearance", () => {
    expect(lightColors).toMatchObject({
      background: "#eef3ed",
      surface: "#f5f9f5",
      surfaceSecondary: "#e8ede7",
      accent: "#2d7a56",
      text: "#1a2e1a",
      textSecondary: "#4a6a4a",
      textTertiary: "#6b8a6b",
    });
  });

  it("provides readable dark surfaces and text", () => {
    expect(darkColors.background).not.toBe(lightColors.background);
    expect(darkColors.surface).not.toBe(lightColors.surface);
    expect(darkColors.surfaceSecondary).not.toBe(lightColors.surfaceSecondary);

    for (const background of [darkColors.background, darkColors.surface]) {
      expect(contrastRatio(darkColors.text, background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(darkColors.textSecondary, background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(darkColors.textTertiary, background)).toBeGreaterThanOrEqual(4.5);
    }

    expect(contrastRatio(darkColors.textInverse, darkColors.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it("provides translucent semantic colors before native adaptation", () => {
    const translucentColors = {
      accentSubtle: "#2d7a5615",
      positiveSubtle: "#16a34a20",
      warningSubtle: "#ca8a0420",
      dangerSubtle: "#dc262620",
    };

    expect(lightColors).toMatchObject(translucentColors);
    expect(darkColors).toMatchObject(translucentColors);
  });
});

describe("createAdaptiveColors", () => {
  it("maps every semantic role to its light and dark variants", () => {
    const adaptiveColor = vi.fn(
      (variants: { light: string; dark: string }) => `${variants.light}|${variants.dark}`,
    );

    const adaptiveColors = createAdaptiveColors(adaptiveColor);

    expect(Object.keys(adaptiveColors)).toEqual(Object.keys(lightColors));
    expect(adaptiveColor).toHaveBeenCalledTimes(Object.keys(lightColors).length);
    expect(adaptiveColors.background).toBe(`${lightColors.background}|${darkColors.background}`);
    expect(adaptiveColors.accentSubtle).toBe(
      `${lightColors.accentSubtle}|${darkColors.accentSubtle}`,
    );
    expect(adaptiveColors.positiveSubtle).toBe(
      `${lightColors.positiveSubtle}|${darkColors.positiveSubtle}`,
    );
    expect(adaptiveColors.warningSubtle).toBe(
      `${lightColors.warningSubtle}|${darkColors.warningSubtle}`,
    );
    expect(adaptiveColors.dangerSubtle).toBe(
      `${lightColors.dangerSubtle}|${darkColors.dangerSubtle}`,
    );
    expect(adaptiveColors.text).toBe(`${lightColors.text}|${darkColors.text}`);
    expect(adaptiveColors.textInverse).toBe(`${lightColors.textInverse}|${darkColors.textInverse}`);
  });
});
