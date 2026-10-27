import { describe, expect, it } from "vitest";
import { GET_STARTED_STEPS, IOS_TESTFLIGHT_INVITE } from "./get-started-flow";

describe("GET_STARTED_STEPS", () => {
  it("guides users through functional setup steps", () => {
    expect(GET_STARTED_STEPS.map((step) => step.id)).toEqual([
      "connect-sources",
      "review-first-insight",
    ]);
  });

  it("includes a provider setup action and a dashboard finish action", () => {
    expect(GET_STARTED_STEPS).toContainEqual(
      expect.objectContaining({
        id: "connect-sources",
        title: "Connect your sources",
        description: "Choose the apps and devices you already use so Dofek can start syncing data.",
        actionLabel: "Set up data sources",
        webPath: "/settings",
        mobilePath: "/providers",
      }),
    );
    expect(GET_STARTED_STEPS).toContainEqual(
      expect.objectContaining({
        id: "review-first-insight",
        title: "Check your dashboard",
        description:
          "Once data is connected, the dashboard shows what is ready and what still needs time.",
        actionLabel: "Open dashboard",
        webPath: "/dashboard",
        mobilePath: "/(tabs)",
      }),
    );
  });

  it("includes the public TestFlight invite link for web onboarding", () => {
    expect(IOS_TESTFLIGHT_INVITE).toEqual({
      title: "Get the iOS app",
      description:
        "Install Dofek on your iPhone or iPad through TestFlight to sync Apple Health and use mobile features.",
      actionLabel: "Open TestFlight invite",
      url: "https://testflight.apple.com/join/FXywHr9c",
    });
  });
});
