/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BehaviorImpactChart } from "./BehaviorImpactChart.tsx";

const mocks = vi.hoisted(() => ({
  impactSummaryUseQuery: vi.fn(),
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

const cachedAssociationData = associationData.slice(0, 1);

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    behaviorImpact: {
      impactSummary: {
        useQuery: mocks.impactSummaryUseQuery,
      },
    },
  },
}));

describe("BehaviorImpactChart", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.impactSummaryUseQuery.mockReset();
    mocks.impactSummaryUseQuery.mockReturnValue({
      data: associationData,
      error: null,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
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

  it("describes the all-history observation window", () => {
    mocks.impactSummaryUseQuery.mockReturnValue({
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

  it("uses the first association-bearing item for evidence in a partial cached response", () => {
    const [firstItem, secondItem] = associationData;
    mocks.impactSummaryUseQuery.mockReturnValue({
      data: firstItem && secondItem ? [{ ...firstItem, association: undefined }, secondItem] : [],
      error: null,
      isLoading: false,
    });

    render(<BehaviorImpactChart days={90} />);

    expect(screen.getByText("Server-computed comparison method.")).toBeDefined();
    expect(screen.getByText("Server observation window.")).toBeDefined();
    expect(screen.getAllByTestId("readiness-association-bar")).toHaveLength(1);
    expect(screen.getByText("Late meal")).toBeDefined();
  });

  it("shows an explicit state when cached rows contain no association evidence", () => {
    mocks.impactSummaryUseQuery.mockReturnValue({
      data: associationData.map((item) => ({ ...item, association: undefined })),
      error: null,
      isLoading: false,
    });

    render(<BehaviorImpactChart days={90} />);

    expect(screen.getByText("Association evidence unavailable")).toBeDefined();
    expect(
      screen.getByText(
        "No association evidence is available for the current results. Log boolean journal entries (Yes/No) for at least 5 days in each group to describe their association with next-day readiness.",
      ),
    ).toBeDefined();
    expect(screen.queryByTestId("readiness-association-axis")).toBeNull();
    expect(screen.queryAllByTestId("readiness-association-bar")).toHaveLength(0);
  });

  it("offers retry after a refresh failure when cached rows contain no association evidence", () => {
    const refetch = vi.fn();
    mocks.impactSummaryUseQuery.mockReturnValue({
      data: associationData.map((item) => ({ ...item, association: undefined })),
      error: new Error("Behavior evidence could not be refreshed."),
      isFetching: false,
      isLoading: false,
      refetch,
    });

    render(<BehaviorImpactChart days={90} />);

    expect(screen.getByText("Association evidence unavailable")).toBeDefined();
    expect(screen.getByText("Behavior evidence could not be refreshed.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry behavior associations" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("does not duplicate the unavailable estimate label", () => {
    mocks.impactSummaryUseQuery.mockReturnValue({
      data: associationData.map((item) => ({
        ...item,
        association: { ...item.association, estimateLabel: "Estimate unavailable" },
      })),
      error: null,
      isLoading: false,
    });

    render(<BehaviorImpactChart days={90} />);

    expect(screen.getAllByText("Estimate unavailable")).toHaveLength(2);
    expect(screen.queryByText("Estimate: Estimate unavailable")).toBeNull();
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

  it("shows busy state instead of an empty state while replacing an empty result", () => {
    mocks.impactSummaryUseQuery
      .mockReturnValueOnce({
        data: [],
        error: null,
        isFetching: false,
        isLoading: false,
        isPlaceholderData: false,
        refetch: vi.fn(),
      })
      .mockReturnValueOnce({
        data: [],
        error: null,
        isFetching: true,
        isLoading: false,
        isPlaceholderData: true,
        refetch: vi.fn(),
      });

    const { rerender } = render(<BehaviorImpactChart days={90} />);
    expect(screen.getByTestId("query-state-empty")).toBeDefined();

    rerender(<BehaviorImpactChart days={30} />);

    expect(screen.getByRole("status", { name: "Loading behavior associations." })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.queryByTestId("query-state-empty")).toBeNull();
  });

  it("retains prior rows and offers retry after a range-change failure", () => {
    const refetch = vi.fn();
    mocks.impactSummaryUseQuery
      .mockReturnValueOnce({
        data: cachedAssociationData,
        error: null,
        isFetching: false,
        isLoading: false,
        refetch: vi.fn(),
      })
      .mockReturnValueOnce({
        data: undefined,
        error: new Error("Behavior associations could not be refreshed."),
        isFetching: false,
        isLoading: false,
        refetch,
      });

    const { rerender } = render(<BehaviorImpactChart days={90} />);
    rerender(<BehaviorImpactChart days={30} />);

    expect(screen.getByText("Meditation")).toBeDefined();
    expect(screen.getByText("Behavior associations could not be refreshed.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry behavior associations" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("announces an initial fetch as a named busy status", () => {
    mocks.impactSummaryUseQuery.mockReturnValue({
      data: undefined,
      error: null,
      isFetching: true,
      isLoading: true,
      refetch: vi.fn(),
    });

    render(<BehaviorImpactChart days={90} />);

    const status = screen.getByRole("status", { name: "Loading behavior associations." });
    expect(status).toHaveAttribute("aria-busy", "true");
  });

  it("keeps cached associations visible while announcing a background refresh", () => {
    mocks.impactSummaryUseQuery.mockReturnValue({
      data: cachedAssociationData,
      error: null,
      isFetching: true,
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<BehaviorImpactChart days={90} />);

    expect(screen.getByText("Meditation")).toBeDefined();
    expect(
      screen.getByRole("status", { name: "Refreshing behavior associations." }),
    ).toHaveAttribute("aria-busy", "true");
  });

  it("shows the server error and retries an initial failure", () => {
    const refetch = vi.fn();
    mocks.impactSummaryUseQuery.mockReturnValue({
      data: undefined,
      error: new Error("Behavior analysis is unavailable for this account."),
      isFetching: false,
      isLoading: false,
      refetch,
    });

    render(<BehaviorImpactChart days={90} />);

    expect(screen.getByText("Behavior analysis is unavailable for this account.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry behavior associations" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("retains cached associations and offers retry after a refresh failure", () => {
    const refetch = vi.fn();
    mocks.impactSummaryUseQuery.mockReturnValue({
      data: cachedAssociationData,
      error: new Error("Behavior associations could not be refreshed."),
      isFetching: false,
      isLoading: false,
      refetch,
    });

    render(<BehaviorImpactChart days={90} />);

    expect(screen.getByText("Meditation")).toBeDefined();
    expect(screen.getByText("Behavior associations could not be refreshed.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry behavior associations" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("renders a distinct empty state after a successful zero-row response", () => {
    mocks.impactSummaryUseQuery.mockReturnValue({
      data: [],
      error: null,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<BehaviorImpactChart days={90} />);

    expect(screen.getByTestId("query-state-empty")).toHaveTextContent(
      "Not enough journal data yet. Log boolean journal entries (Yes/No) for at least 5 days in each group to describe their association with next-day readiness.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
