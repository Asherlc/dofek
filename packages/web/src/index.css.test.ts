import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const indexCss = readFileSync(new URL("./index.css", import.meta.url), "utf8");

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

function readThemeToken(theme: "light" | "dark", token: string): string {
  const themeBlock =
    theme === "light"
      ? indexCss.match(/@theme\s*{([\s\S]*?)\n}/)?.[1]
      : indexCss.match(
          /@media \(prefers-color-scheme: dark\)\s*{\s*:root\s*{([\s\S]*?)\n\s*}\s*}/,
        )?.[1];
  if (!themeBlock) throw new Error(`Could not find ${theme} theme block`);

  const value = themeBlock.match(new RegExp(`--color-${token}:\\s*(#[0-9a-f]{6})`))?.[1];
  if (!value) throw new Error(`Could not find ${token} in ${theme} theme`);
  return value;
}

describe("web color tokens", () => {
  it("keeps tiny-label and secondary-tab tokens at WCAG AA contrast in both themes", () => {
    const themes = [
      { name: "light", page: "#eef3ed", surface: "#f5f9f5" },
      { name: "dark", page: "#0c1410", surface: "#19261e" },
    ] as const;

    for (const theme of themes) {
      for (const token of ["accent-secondary", "subtle", "dim"] as const) {
        const foreground = readThemeToken(theme.name, token);
        for (const [backgroundName, background] of [
          ["page", theme.page],
          ["surface", theme.surface],
        ] as const) {
          expect(
            contrastRatio(foreground, background),
            `${theme.name} ${token} on ${backgroundName}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});
