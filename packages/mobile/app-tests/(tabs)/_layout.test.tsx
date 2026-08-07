import { describe, expect, it } from "vitest";
import { getTabIconName, selectedTabBackgroundColor } from "../../lib/tab-selection";
import { colors } from "../../theme";

describe("tab layout selected state", () => {
  it("uses filled icons for focused tabs and outline icons for unfocused tabs", () => {
    expect(getTabIconName("index", true)).toBe("today");
    expect(getTabIconName("index", false)).toBe("today-outline");
    expect(getTabIconName("recovery", true)).toBe("pulse");
    expect(getTabIconName("recovery", false)).toBe("pulse-outline");
    expect(getTabIconName("strain", true)).toBe("barbell");
    expect(getTabIconName("strain", false)).toBe("barbell-outline");
    expect(getTabIconName("food", true)).toBe("nutrition");
    expect(getTabIconName("food", false)).toBe("nutrition-outline");
  });

  it("sets a distinct active tab background color", () => {
    expect(selectedTabBackgroundColor).toBe(colors.surfaceSecondary);
  });
});
