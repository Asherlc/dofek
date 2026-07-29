/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BehaviorImpactChart } from "./BehaviorImpactChart.tsx";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

const associationData = [
  {
    questionSlug: "meditation",
    displayName: "Meditation",
    category: "wellness",
    impactPercent: 18.6,
    yesCount: 18,
    noCount: 24,
  },
  {
    questionSlug: "late-meal",
    displayName: "Late meal",
    category: "nutrition",
    impactPercent: -12.4,
    yesCount: 14,
    noCount: 28,
  },
];

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    behaviorImpact: {
      impactSummary: {
        useQuery: mocks.query,
      },
    },
  },
}));

describe("BehaviorImpactChart", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockReturnValue({
      data: associationData,
      error: null,
      isLoading: false,
    });
  });

  it("presents descriptive associations with method, samples, window, and interval status", () => {
    render(<BehaviorImpactChart days={90} />);

    expect(screen.getByText("Association with Next-Day Readiness")).toBeDefined();
    expect(
      screen.getByText(
        "Method: (mean next-day readiness after Yes − mean after No) ÷ mean after No × 100.",
      ),
    ).toBeDefined();
    expect(screen.getByText("Association does not establish causation.")).toBeDefined();
    expect(
      screen.getByText("Uncertainty interval: not available for this descriptive comparison."),
    ).toBeDefined();
    expect(screen.getByText("Selected window: 90 days")).toBeDefined();
    expect(screen.getByText("Yes n = 18 · No n = 24")).toBeDefined();
    expect(screen.getByText("Yes n = 14 · No n = 28")).toBeDefined();
    expect(screen.getByText("18.6% higher")).toBeDefined();
    expect(screen.getByText("12.4% lower")).toBeDefined();
    expect(screen.getByText("LOWER")).toBeDefined();
    expect(screen.getByText("HIGHER")).toBeDefined();

    for (const bar of screen.getAllByTestId("readiness-association-bar")) {
      expect(bar.getAttribute("data-tone")).toBe("neutral");
    }
  });

  it("describes the all-history observation window", () => {
    render(<BehaviorImpactChart days={null} />);

    expect(screen.getByText("Selected window: all available history")).toBeDefined();
  });

  it("stacks association details at narrow widths and adds columns at the small breakpoint", () => {
    render(<BehaviorImpactChart days={90} />);

    for (const bar of screen.getAllByTestId("readiness-association-bar")) {
      const classes = bar.getAttribute("class");
      expect(classes).toContain("grid");
      expect(classes).toContain("sm:grid-cols-[10rem_minmax(0,1fr)_6rem]");
      expect(classes).not.toContain("w-40");
      expect(classes).not.toContain("w-24");
    }

    const axis = screen.getByTestId("readiness-association-axis");
    expect(axis.getAttribute("class")).toContain("hidden");
    expect(axis.getAttribute("class")).toContain("sm:grid");
  });

  it("uses association language in the insufficient-data state", () => {
    mocks.query.mockReturnValue({ data: [], error: null, isLoading: false });

    render(<BehaviorImpactChart days={90} />);

    expect(
      screen.getByText(
        "Not enough journal data yet. Log boolean journal entries (Yes/No) for at least 5 days in each group to describe their association with next-day readiness.",
      ),
    ).toBeDefined();
  });

  it("surfaces the server error message", () => {
    mocks.query.mockReturnValue({
      data: undefined,
      error: new Error("Behavior association data is unavailable."),
      isLoading: false,
    });

    render(<BehaviorImpactChart days={90} />);

    expect(screen.getByText("Behavior association data is unavailable.")).toBeDefined();
  });

  it("keeps cached associations visible while loading", () => {
    mocks.query.mockReturnValue({
      data: associationData,
      error: null,
      isLoading: true,
    });

    render(<BehaviorImpactChart days={90} />);

    expect(screen.getAllByTestId("readiness-association-bar")).toHaveLength(2);
    expect(screen.queryByText("Behavior association data is unavailable.")).toBeNull();
  });

  it("keeps cached associations visible alongside a refresh error", () => {
    mocks.query.mockReturnValue({
      data: associationData,
      error: new Error("Behavior association data is unavailable."),
      isLoading: false,
    });

    render(<BehaviorImpactChart days={90} />);

    expect(screen.getAllByTestId("readiness-association-bar")).toHaveLength(2);
    expect(screen.getByText("Behavior association data is unavailable.")).toBeDefined();
  });
});
