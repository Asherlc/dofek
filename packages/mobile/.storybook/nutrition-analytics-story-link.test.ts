import { createTRPCProxyClient } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { describe, expect, it } from "vitest";
import { createNutritionAnalyticsStoryLink } from "./nutrition-analytics-story-link";

describe("createNutritionAnalyticsStoryLink", () => {
  it("returns the configured nutrition analytics data", async () => {
    const client = createTRPCProxyClient<AppRouter>({
      links: [createNutritionAnalyticsStoryLink()],
    });

    await expect(client.nutritionAnalytics.adaptiveTdee.query()).resolves.toMatchObject({
      estimatedTdee: 2_250,
    });
  });

  it("returns the configured nutrition analytics error", async () => {
    const client = createTRPCProxyClient<AppRouter>({
      links: [createNutritionAnalyticsStoryLink("error")],
    });

    await expect(client.nutritionAnalytics.adaptiveTdee.query()).rejects.toThrow(
      "Body measurements are unavailable.",
    );
  });

  it("returns the adaptive TDEE evidence-unavailable scenario", async () => {
    const client = createTRPCProxyClient<AppRouter>({
      links: [createNutritionAnalyticsStoryLink("unavailable")],
    });

    await expect(client.nutritionAnalytics.adaptiveTdee.query()).resolves.toMatchObject({
      status: "unavailable",
      unavailableReason: "No body-weight measurements are available in the selected period.",
      evidence: { calorieDays: 90, weightDays: 0 },
    });
  });

  it("rejects an unhandled tRPC path", async () => {
    const client = createTRPCProxyClient<AppRouter>({
      links: [createNutritionAnalyticsStoryLink()],
    });

    await expect(client.settings.get.query({ key: "unitSystem" })).rejects.toThrow(
      "Unhandled Storybook tRPC path: settings.get",
    );
  });
});
