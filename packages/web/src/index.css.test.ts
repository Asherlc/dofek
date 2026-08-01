import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const indexCss = readFileSync(new URL("./index.css", import.meta.url), "utf8");

type RgbColor = readonly [red: number, green: number, blue: number];

type CssColor = {
  alpha: number;
  rgb: RgbColor;
};

function extractBalancedBlock(css: string, openingBraceIndex: number): string {
  let depth = 0;
  let quote: '"' | "'" | undefined;

  for (let index = openingBraceIndex; index < css.length; index += 1) {
    const character = css[index];

    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return css.slice(openingBraceIndex + 1, index);
      }
    }
  }

  throw new Error("Unclosed CSS block in contrast test");
}

function extractBlockAfter(css: string, selector: RegExp, label: string): string {
  const selectorMatch = selector.exec(css);
  if (!selectorMatch) {
    throw new Error(`Could not find ${label} block`);
  }

  const openingBraceIndex = css.indexOf("{", selectorMatch.index + selectorMatch[0].length);
  if (openingBraceIndex === -1) {
    throw new Error(`Could not find opening brace for ${label} block`);
  }

  return extractBalancedBlock(css, openingBraceIndex);
}

function readThemeBlock(css: string, theme: "light" | "dark"): string {
  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

  if (theme === "light") {
    return extractBlockAfter(cssWithoutComments, /@theme\b/i, "light theme");
  }

  const darkMediaBlock = extractBlockAfter(
    cssWithoutComments,
    /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i,
    "dark color scheme",
  );
  return extractBlockAfter(darkMediaBlock, /:root\b/i, "dark theme");
}

function readThemeToken(css: string, theme: "light" | "dark", token: string): string {
  const themeBlock = readThemeBlock(css, theme);
  const propertyName = `--color-${token}`;

  for (const declaration of themeBlock.split(";")) {
    const colonIndex = declaration.indexOf(":");
    if (colonIndex === -1 || declaration.slice(0, colonIndex).trim() !== propertyName) {
      continue;
    }

    const value = declaration.slice(colonIndex + 1).trim();
    if (value) {
      return value;
    }
  }

  throw new Error(`Could not find ${token} in ${theme} theme`);
}

function parseColor(value: string): CssColor {
  const normalizedValue = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(normalizedValue);
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

  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(0|1|0?\.\d+)\s*\)$/i.exec(
    normalizedValue,
  );
  if (rgba?.[1] && rgba[2] && rgba[3] && rgba[4]) {
    return {
      alpha: Number.parseFloat(rgba[4]),
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
    };
  }

  throw new Error(
    `Unsupported CSS color syntax in contrast test (expected #rrggbb or rgba()): ${normalizedValue}`,
  );
}

function compositeOver(foreground: CssColor, background: RgbColor): RgbColor {
  return [
    foreground.rgb[0] * foreground.alpha + background[0] * (1 - foreground.alpha),
    foreground.rgb[1] * foreground.alpha + background[1] * (1 - foreground.alpha),
    foreground.rgb[2] * foreground.alpha + background[2] * (1 - foreground.alpha),
  ];
}

function relativeLuminance(rgb: RgbColor): number {
  const linearChannel = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linearChannel(rgb[0]) + 0.7152 * linearChannel(rgb[1]) + 0.0722 * linearChannel(rgb[2])
  );
}

function contrastRatio(foreground: RgbColor, background: RgbColor): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function colorChroma(rgb: RgbColor): number {
  return Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
}

function colorDistance(first: RgbColor, second: RgbColor): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

describe("web color tokens", () => {
  it("reads reformatted theme blocks and current CSS color syntax", () => {
    const reformattedCss = `
      @theme
      {
        --color-page:
          #EEF3ED
        ;
        --color-surface: rgba(
          255, 255, 255, 0.65
        )
        ;
      }

      @media (
        prefers-color-scheme:
          dark
      )
      {
        :root
        {
          --color-page: #0C1410
        }
      }
    `;

    expect(parseColor(readThemeToken(reformattedCss, "light", "page"))).toEqual({
      alpha: 1,
      rgb: [238, 243, 237],
    });
    expect(parseColor(readThemeToken(reformattedCss, "light", "surface"))).toEqual({
      alpha: 0.65,
      rgb: [255, 255, 255],
    });
    expect(readThemeToken(reformattedCss, "dark", "page")).toBe("#0C1410");
  });

  it("keeps tiny-label and secondary-tab tokens at WCAG AA contrast in both themes", () => {
    const themes = [{ name: "light" }, { name: "dark" }] as const;

    for (const theme of themes) {
      const page = parseColor(readThemeToken(indexCss, theme.name, "page"));
      const surface = parseColor(readThemeToken(indexCss, theme.name, "surface"));
      const surfaceSolid = parseColor(readThemeToken(indexCss, theme.name, "surface-solid"));

      for (const token of ["accent-secondary", "subtle", "dim"] as const) {
        const foreground = parseColor(readThemeToken(indexCss, theme.name, token));
        for (const [backgroundName, background] of [
          ["page", page.rgb],
          ["surface", compositeOver(surface, page.rgb)],
          ["surface-solid", surfaceSolid.rgb],
        ] as const) {
          const effectiveForeground = compositeOver(foreground, background);
          expect(
            contrastRatio(effectiveForeground, background),
            `${theme.name} ${token} on ${backgroundName}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }

    const lightPage = parseColor(readThemeToken(indexCss, "light", "page"));
    const lightSubtle = parseColor(readThemeToken(indexCss, "light", "subtle"));
    const lightDim = parseColor(readThemeToken(indexCss, "light", "dim"));
    const subtleOnPage = compositeOver(lightSubtle, lightPage.rgb);
    const dimOnPage = compositeOver(lightDim, lightPage.rgb);

    expect(
      contrastRatio(dimOnPage, lightPage.rgb),
      "light dim should be less prominent than light subtle",
    ).toBeLessThan(contrastRatio(subtleOnPage, lightPage.rgb));
    expect(
      colorChroma(dimOnPage),
      "light dim should be less chromatic than light subtle",
    ).toBeLessThan(colorChroma(subtleOnPage));
    expect(
      colorDistance(dimOnPage, subtleOnPage),
      "light dim and subtle should remain perceivably distinct",
    ).toBeGreaterThan(16);
  });
});
