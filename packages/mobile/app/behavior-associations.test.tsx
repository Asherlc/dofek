// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted<{
  query: ReturnType<typeof vi.fn>;
  queryInputs: Array<{ days: number }>;
  refetch: ReturnType<typeof vi.fn>;
}>(() => ({
  query: vi.fn(),
  queryInputs: [],
  refetch: vi.fn(),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    behaviorImpact: {
      impactSummary: {
        useQuery: (input: { days: number }) => {
          mocks.queryInputs.push(input);
          return mocks.query();
        },
      },
    },
  },
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

describe("BehaviorAssociationsScreen", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.query.mockReset();
    mocks.queryInputs.length = 0;
    mocks.refetch.mockReset();
    mocks.query.mockReturnValue({
      data: associationData,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });
  });

  it("presents descriptive associations with method, samples, window, and interval status", async () => {
    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    expect(screen.getByText("Behavior Associations")).toBeTruthy();
    expect(
      screen.getByText("How your daily behaviors are associated with next-day readiness"),
    ).toBeTruthy();
    expect(screen.getByText("Method: Server-computed comparison method.")).toBeTruthy();
    expect(
      screen.getByText(
        "Interpretation: Server interpretation: association, not causation or prescription.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Uncertainty: Server uncertainty statement.")).toBeTruthy();
    expect(screen.getByText("Observation window: Server observation window.")).toBeTruthy();
    expect(screen.getByText("Yes n = 18 · No n = 24")).toBeTruthy();
    expect(screen.getByText("Yes n = 14 · No n = 28")).toBeTruthy();
    expect(screen.getByText("Estimate: 18.6% higher")).toBeTruthy();
    expect(screen.getByText("Estimate: 12.4% lower")).toBeTruthy();
    expect(mocks.queryInputs.at(-1)).toEqual({ days: 90 });
  });

  it("renders relationship semantics supplied by the server", async () => {
    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    expect(screen.getByText("Method: Server-computed comparison method.")).toBeTruthy();
    expect(
      screen.getByText(
        "Interpretation: Server interpretation: association, not causation or prescription.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Uncertainty: Server uncertainty statement.")).toBeTruthy();
    expect(screen.getByText("Observation window: Server observation window.")).toBeTruthy();
    expect(screen.getByText("Estimate: 18.6% higher")).toBeTruthy();
    expect(screen.getByText("Estimate: 12.4% lower")).toBeTruthy();
  });

  it("queries the selected observation window", async () => {
    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    fireEvent.click(screen.getByRole("radio", { name: "30d" }));

    expect(screen.getByText("Observation window: Server observation window.")).toBeTruthy();
    expect(mocks.queryInputs.at(-1)).toEqual({ days: 30 });
  });

  it("skips partial cached rows without losing server evidence from later rows", async () => {
    const [firstAssociation, secondAssociation] = associationData;
    mocks.query.mockReturnValue({
      data:
        firstAssociation && secondAssociation
          ? [{ ...firstAssociation, association: undefined }, secondAssociation]
          : [],
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });

    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    expect(screen.getByText("Method: Server-computed comparison method.")).toBeTruthy();
    expect(screen.getByText("Estimate: 12.4% lower")).toBeTruthy();
    expect(screen.queryByText("Estimate: 18.6% higher")).toBeNull();
  });

  it("shows an explicit state when cached rows contain no association evidence", async () => {
    mocks.query.mockReturnValue({
      data: associationData.map((item) => ({ ...item, association: undefined })),
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });

    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    expect(screen.getByText("Association evidence unavailable")).toBeTruthy();
    expect(
      screen.getByText(
        "No association evidence is available for the current results. Log boolean journal entries (Yes/No) for at least 5 days in each group to describe their association with next-day readiness.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Meditation")).toBeNull();
    expect(screen.queryByText("Late meal")).toBeNull();
  });

  it("does not duplicate the unavailable estimate label", async () => {
    mocks.query.mockReturnValue({
      data: associationData.map((item) => ({
        ...item,
        association: { ...item.association, estimateLabel: "Estimate unavailable" },
      })),
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });

    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    expect(screen.getAllByText("Estimate unavailable")).toHaveLength(2);
    expect(screen.queryByText("Estimate: Estimate unavailable")).toBeNull();
  });

  it("shows source labels and reveals raw IDs only through accessible technical details", async () => {
    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    expect(screen.getByText("Source: Manual review")).toBeTruthy();
    expect(screen.getByText("Sources: Manual review, WHOOP (Cloud)")).toBeTruthy();
    expect(screen.queryByText("Provider ID: manual_review")).toBeNull();

    const technicalDetailsButton = screen.getAllByRole("button", {
      name: "Show technical source details for Manual review",
    })[0];
    if (!technicalDetailsButton) throw new Error("Technical source details button is missing");
    fireEvent.click(technicalDetailsButton);

    expect(screen.getByText("Provider ID: manual_review")).toBeTruthy();
  });

  it("uses association language in the insufficient-data state", async () => {
    mocks.query.mockReturnValue({
      data: [],
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });

    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    expect(
      screen.getByText(
        "Log boolean journal entries (Yes/No) for at least 5 days in each group to describe their association with next-day readiness.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Evidence")).toBeNull();
  });

  it("does not render a blank evidence card while the initial query is loading", async () => {
    mocks.query.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
      isFetching: true,
      refetch: mocks.refetch,
    });

    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    expect(screen.queryByText("Evidence")).toBeNull();
  });

  it("surfaces the server error and retries it", async () => {
    mocks.query.mockReturnValue({
      data: undefined,
      error: new Error("Behavior association data is unavailable."),
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });

    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    expect(screen.getByText("Behavior association data is unavailable.")).toBeTruthy();
    expect(screen.queryByText("Evidence")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry behavior associations" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it("surfaces an error instead of an empty state when cached data is empty", async () => {
    mocks.query.mockReturnValue({
      data: [],
      error: new Error("Behavior association data is unavailable."),
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });

    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    expect(screen.getByText("Behavior association data is unavailable.")).toBeTruthy();
    expect(screen.queryByText("Not enough journal data yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry behavior associations" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it("keeps cached associations visible while loading", async () => {
    mocks.query.mockReturnValue({
      data: associationData,
      error: null,
      isLoading: true,
      isFetching: true,
      refetch: mocks.refetch,
    });

    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    expect(screen.getByText("Estimate: 18.6% higher")).toBeTruthy();
    expect(screen.getByText("Estimate: 12.4% lower")).toBeTruthy();
  });

  it("keeps cached associations and retry visible after a refresh error", async () => {
    mocks.query.mockReturnValue({
      data: associationData,
      error: new Error("Behavior association data is unavailable."),
      isLoading: false,
      isFetching: false,
      refetch: mocks.refetch,
    });

    const { default: BehaviorAssociationsScreen } = await import("./behavior-associations");
    render(<BehaviorAssociationsScreen />);

    expect(screen.getByText("Estimate: 18.6% higher")).toBeTruthy();
    expect(screen.getByText("Estimate: 12.4% lower")).toBeTruthy();
    expect(screen.getByText("Behavior association data is unavailable.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry behavior associations" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});
