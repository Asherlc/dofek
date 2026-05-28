import { describe, expect, it } from "vitest";
import { GET_STARTED_GOALS, GET_STARTED_STEPS } from "./get-started-flow";

describe("GET_STARTED_GOALS", () => {
  it("offers focused setup goals for new users", () => {
    expect(GET_STARTED_GOALS.map((goal) => goal.id)).toEqual([
      "training",
      "recovery",
      "nutrition",
      "full-picture",
    ]);
  });

  it("uses readable labels and descriptions", () => {
    for (const goal of GET_STARTED_GOALS) {
      expect(goal.title.length).toBeGreaterThan(0);
      expect(goal.description.length).toBeGreaterThan(0);
      expect(goal.description).not.toMatch(/\b(CTL|ATL|TSB|ACWR|FTP|HRV|EF|NP|VI|IF|PI|CP)\b/);
    }
  });
});

describe("GET_STARTED_STEPS", () => {
  it("guides users from goal choice to first insight", () => {
    expect(GET_STARTED_STEPS.map((step) => step.id)).toEqual([
      "choose-goal",
      "connect-sources",
      "set-up-mobile",
      "review-first-insight",
    ]);
  });

  it("includes a provider setup action and a dashboard finish action", () => {
    expect(GET_STARTED_STEPS).toContainEqual(
      expect.objectContaining({
        id: "connect-sources",
        actionLabel: "Set up data sources",
        webPath: "/settings",
        mobilePath: "/providers",
      }),
    );
    expect(GET_STARTED_STEPS).toContainEqual(
      expect.objectContaining({
        id: "review-first-insight",
        actionLabel: "Open dashboard",
        webPath: "/dashboard",
        mobilePath: "/(tabs)",
      }),
    );
  });
});
