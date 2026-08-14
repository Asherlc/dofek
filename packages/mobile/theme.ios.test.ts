import { describe, expect, it } from "vitest";
import { colors } from "./theme.ios";
import { darkColors, lightColors } from "./theme-palette";

describe("iOS semantic colors", () => {
  it("uses native dynamic colors for every semantic role", () => {
    expect(colors.background).toEqual({
      light: lightColors.background,
      dark: darkColors.background,
    });
    expect(colors.surface).toEqual({
      light: lightColors.surface,
      dark: darkColors.surface,
    });
    expect(colors.text).toEqual({
      light: lightColors.text,
      dark: darkColors.text,
    });
    expect(colors.textInverse).toEqual({
      light: lightColors.textInverse,
      dark: darkColors.textInverse,
    });
  });
});
