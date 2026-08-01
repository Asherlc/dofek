import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const indexCss = readFileSync(new URL("./index.css", import.meta.url), "utf8");

type RgbColor = readonly [red: number, green: number, blue: number];

type CssColor = {
  alpha: number;
  rgb: RgbColor;
};

function parseColor(value: string): CssColor {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    return {
      alpha: 1,
      rgb: [
        Number.parseInt(hex[1].slice(0, 2), 16),
        Number.parseInt(hex[1].slice(2, 4), 16),
        Number.parseInt(hex[1].slice(4, 6), 16),
      ],
    };
  }

  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(0|1|0?\.\d+)\s*\)$/i.exec(value);
  if (rgba?.[1] && rgba[2] && rgba[3] && rgba[4]) {
    return {
      alpha: Number.parseFloat(rgba[4]),
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
    };
  }

  throw new Error(`Unsupported CSS color: ${value}`);
}

function compositeOver(foreground: CssColor, background: RgbColor): RgbColor {
  return [
    foreground.rgb[0] * foreground.alpha + background[0] * (1 - foreground.alpha),
    foreground.rgb[1] * foreground.alpha + background[1] * (1 - foreground.alpha),
    foreground.rgb[2] * foreground.alpha + background[2] * (1 - foreground.alpha),
  ];
}

function relativeLuminance(rgb: RgbColor): number {
  const linearChannel = (start: number) => {
    const channel = rgb[start] / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearChannel(0) + 0.7152 * linearChannel(1) + 0.0722 * linearChannel(2);
}

function contrastRatio(foreground: RgbColor, background: RgbColor): number {
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

  const prefix = `--color-${token}:`;
  const line = themeBlock.split("\n").find((candidate) => candidate.trimStart().startsWith(prefix));
  const value = line
    ?.slice(line.indexOf(":") + 1)
    .trim()
    .replace(/;$/, "");
  if (!value) throw new Error(`Could not find ${token} in ${theme} theme`);
  return value;
}

describe("web color tokens", () => {
  it("keeps tiny-label and secondary-tab tokens at WCAG AA contrast in both themes", () => {
    const themes = [{ name: "light" }, { name: "dark" }] as const;

    for (const theme of themes) {
      const page = parseColor(readThemeToken(theme.name, "page"));
      const surface = parseColor(readThemeToken(theme.name, "surface"));
      const surfaceSolid = parseColor(readThemeToken(theme.name, "surface-solid"));

      for (const token of ["accent-secondary", "subtle", "dim"] as const) {
        const foreground = parseColor(readThemeToken(theme.name, token)).rgb;
        for (const [backgroundName, background] of [
          ["page", page.rgb],
          ["surface", compositeOver(surface, page.rgb)],
          ["surface-solid", surfaceSolid.rgb],
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
