import { describe, expect, it } from "vitest";
import { TABS } from "../../app/food/add-types";

describe("food add tabs", () => {
  it("exposes every food input mode", () => {
    expect(TABS).toEqual([
      { key: "search", label: "Search" },
      { key: "scan", label: "Scan" },
      { key: "quickadd", label: "Quick Add" },
      { key: "ai", label: "AI" },
    ]);
  });
});
