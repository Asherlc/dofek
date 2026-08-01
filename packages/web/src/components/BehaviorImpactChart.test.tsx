/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    sources: [{ providerId: "manual_review", label: "Manual review" }],
    association: {
      relationship: "descriptive_association",
      direction: "higher",
      estimateLabel: "18.6% higher",
      method: "Server-computed comparison method.",
      interpretation: "Server interpretation: association, not causation or prescription.",
      uncertainty: "Server uncertainty statement.",
      observationWindow: "Server observation window.",
    },
  },
  {
    questionSlug: "late-meal",
    displayName: "Late meal",
    category: "nutrition",
    impactPercent: -12.4,
    yesCount: 14,
    noCount: 28,
    sources: [
      { providerId: "manual_review", label: "Manual review" },
      { providerId: "whoop", label: "WHOOP (Cloud)" },
    ],
    association: {
      relationship: "descriptive_association",
      direction: "lower",
      estimateLabel: "12.4% lower",
      method: "Server-computed comparison method.",
      interpretation: "Server interpretation: association, not causation or prescription.",
      uncertainty: "Server uncertainty statement.",
      observationWindow: "Server observation window.",
    },
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
    expect(screen.getByText("Server-computed comparison method.")).toBeDefined();
    expect(
      screen.getByText("Server interpretation: association, not causation or prescription."),
    ).toBeDefined();
    expect(screen.getByText("Server uncertainty statement.")).toBeDefined();
    expect(screen.getByText("Server observation window.")).toBeDefined();
    expect(screen.getByText("Yes n = 18 · No n = 24")).toBeDefined();
    expect(screen.getByText("Yes n = 14 · No n = 28")).toBeDefined();
    expect(screen.getByText("Estimate: 18.6% higher")).toBeDefined();
    expect(screen.getByText("Estimate: 12.4% lower")).toBeDefined();
    expect(screen.getByText("LOWER")).toBeDefined();
    expect(screen.getByText("HIGHER")).toBeDefined();

    for (const bar of screen.getAllByTestId("readiness-association-bar")) {
      expect(bar.getAttribute("data-tone")).toBe("neutral");
    }
  });

  it("renders relationship semantics supplied by the server", () => {
    render(<BehaviorImpactChart days={90} />);

    expect(screen.getByText("Server-computed comparison method.")).toBeDefined();
    expect(
      screen.getByText("Server interpretation: association, not causation or prescription."),
    ).toBeDefined();
    expect(screen.getByText("Server uncertainty statement.")).toBeDefined();
    expect(screen.getByText("Server observation window.")).toBeDefined();
    expect(screen.getByText("Estimate: 18.6% higher")).toBeDefined();
    expect(screen.getByText("Estimate: 12.4% lower")).toBeDefined();
  });

  it("describes the all-history observation window", () => {
    mocks.query.mockReturnValue({
      data: associationData.map((item) => ({
        ...item,
        association: { ...item.association, observationWindow: "all available history" },
      })),
      error: null,
      isLoading: false,
    });

    render(<BehaviorImpactChart days={null} />);

    expect(screen.getByText("all available history")).toBeDefined();
  });

  it("does not crash when a partial cached item lacks association evidence", () => {
    const [firstItem] = associationData;
    mocks.query.mockReturnValue({
      data: firstItem ? [{ ...firstItem, association: undefined }] : [],
      error: null,
      isLoading: false,
    });

    render(<BehaviorImpactChart days={90} />);

    expect(screen.getByText("Association with Next-Day Readiness")).toBeDefined();
  });

  it("shows source labels and reveals raw IDs only through accessible technical details", () => {
    render(<BehaviorImpactChart days={90} />);

    expect(screen.getByText("Source: Manual review")).toBeDefined();
    expect(screen.getByText("Sources: Manual review, WHOOP (Cloud)")).toBeDefined();
    expect(screen.queryByText("Provider ID: manual_review")).toBeNull();

    const technicalDetailsButton = screen.getAllByRole("button", {
      name: "Show technical source details for Manual review",
    })[0];
    if (!technicalDetailsButton) throw new Error("Technical source details button is missing");
    fireEvent.click(technicalDetailsButton);

    expect(screen.getByText("Provider ID: manual_review")).toBeDefined();
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
