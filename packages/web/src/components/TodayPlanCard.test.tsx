/** @vitest-environment jsdom */

import type { TodayPlanResult } from "@dofek/scoring/today-plan";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TodayPlanCard } from "./TodayPlanCard.tsx";

const readyPlan: TodayPlanResult = {
  status: "ready",
  date: "2026-07-26",
  action: {
    id: "strain_target",
    title: "Train hard today — aim for 16.2 strain",
    summary: "Recovery is strong (82). Push for a high-strain day to build fitness.",
    zone: "Push",
  },
  supportingFacts: [
    { label: "Recovery", value: "82/100" },
    { label: "Sleep performance", value: "88 (Good)" },
  ],
  caveats: [],
  confidence: "high",
  freshness: {
    recoveryDate: "2026-07-26",
    sleepDate: "2026-07-26",
  },
  missingInputs: [],
};

const insufficientPlan: TodayPlanResult = {
  status: "insufficient_data",
  date: "2026-07-26",
  action: null,
  supportingFacts: [],
  confidence: "low",
  freshness: {
    recoveryDate: null,
    sleepDate: null,
  },
  missingInputs: ["recovery"],
  message:
    "Connect a recovery source and wait for today's recovery score before a training plan can be generated.",
};

const planWithCaveat = {
  ...readyPlan,
  caveats: [
    "Sleep and recent workload data were unavailable, so this plan uses recovery and the strain target.",
  ],
};

describe("TodayPlanCard", () => {
  it("renders the server action and supporting facts", () => {
    render(<TodayPlanCard plan={readyPlan} />);

    expect(screen.getByText("What matters today")).toBeTruthy();
    expect(screen.getByText("Train hard today — aim for 16.2 strain")).toBeTruthy();
    expect(screen.getByText(/Recovery is strong/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Why this?" }));
    expect(screen.getByText("Recovery")).toBeTruthy();
    expect(screen.getByText("82/100")).toBeTruthy();
    expect(screen.getByText("Sleep performance")).toBeTruthy();
    expect(screen.getByText("88 (Good)")).toBeTruthy();
    expect(screen.getByText("High confidence")).toBeTruthy();
    expect(screen.getByText(/Recovery data from 2026-07-26/)).toBeTruthy();
  });

  it("discloses server-authored observations and caveats with an accessible Why this control", () => {
    render(<TodayPlanCard plan={planWithCaveat} />);

    const disclosure = screen.getByRole("button", { name: "Why this?" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(disclosure);

    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Contributing observations")).toBeTruthy();
    expect(screen.getByText("Recovery")).toBeTruthy();
    expect(
      screen.getByText(
        "Sleep and recent workload data were unavailable, so this plan uses recovery and the strain target.",
      ),
    ).toBeTruthy();
  });

  it("renders the insufficient-data message from the server", () => {
    render(<TodayPlanCard plan={insufficientPlan} />);

    expect(screen.getByText("What matters today")).toBeTruthy();
    expect(
      screen.getByText(
        "Connect a recovery source and wait for today's recovery score before a training plan can be generated.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Train hard today — aim for 16.2 strain")).toBeNull();
  });

  it("renders a loading state", () => {
    render(<TodayPlanCard plan={undefined} loading />);
    expect(screen.getByRole("region", { name: "What matters today" })).toBeTruthy();
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
  });

  it("renders a server error message", () => {
    render(<TodayPlanCard plan={undefined} error={new Error("Today plan unavailable")} />);
    expect(screen.getByRole("region", { name: "What matters today" })).toBeTruthy();
    expect(screen.getByText("Today plan unavailable")).toBeTruthy();
  });

  it("keeps cached plan visible with a background refresh error", () => {
    render(<TodayPlanCard plan={readyPlan} error={new Error("Today plan refresh failed")} />);

    expect(screen.getByText("Train hard today — aim for 16.2 strain")).toBeTruthy();
    expect(screen.getByText("Today plan refresh failed")).toBeTruthy();
  });
});
