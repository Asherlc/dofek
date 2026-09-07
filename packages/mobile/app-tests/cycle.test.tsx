// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  phase: vi.fn(),
  history: vi.fn(),
}));

vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    menstrualCycle: {
      currentPhase: { useQuery: () => mocks.phase() },
      history: { useQuery: () => mocks.history() },
    },
  },
}));

const estimatedPhase = {
  phase: "menstrual",
  dayOfCycle: 3,
  cycleLength: 28,
  latestCycleStart: null,
  estimate: {
    phaseLabel: "Estimated Menstrual phase",
    cycleDayLabel: "Day 3 of an estimated 28-day cycle",
    dayBasisLabel: "Cycle day is counted from the latest provider cycle-start record.",
    methodLabel: "Phase and cycle length use the average of 3 completed cycles.",
    uncertaintyLabel: "Recorded cycle lengths ranged from 27 to 29 days.",
    limitationLabel: "No calibrated confidence score or next-period forecast is available.",
  },
  availability: { status: "estimated", label: "Phase estimate available." },
};

describe("CycleScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.phase.mockReturnValue({ data: undefined, error: null, isLoading: false });
    mocks.history.mockReturnValue({ data: [], error: null, isLoading: false });
  });

  it("renders the complete server-authored estimate and safety notice", async () => {
    mocks.phase.mockReturnValue({ data: estimatedPhase, error: null, isLoading: false });
    const { default: CycleScreen } = await import("../app/cycle");
    render(<CycleScreen />);

    expect(screen.getByText("Estimated Menstrual phase")).toBeTruthy();
    expect(screen.getByText("Day 3 of an estimated 28-day cycle")).toBeTruthy();
    expect(screen.getByText(/average of 3 completed cycles/)).toBeTruthy();
    expect(screen.getByText(/ranged from 27 to 29 days/)).toBeTruthy();
    expect(screen.getByText(/No calibrated confidence score/)).toBeTruthy();
    expect(screen.getByLabelText(/Cycle tracking safety notice/).textContent).toContain(
      "Do not use for birth control or diagnosis",
    );
  });

  it("renders exact-date history with every provider source", async () => {
    mocks.history.mockReturnValue({
      data: [
        {
          id: "cycle-start:2026-08-01",
          startDate: "2026-08-01",
          sources: [
            { providerId: "apple_health", sourceName: "Cycle Source", sourceBundle: "com.cycle" },
            { providerId: "garmin", sourceName: null, sourceBundle: "com.garmin.connect" },
          ],
        },
      ],
      error: null,
      isLoading: false,
    });
    const { default: CycleScreen } = await import("../app/cycle");
    render(<CycleScreen />);

    const item = screen.getByLabelText("Cycle start 2026-08-01");
    expect(within(item).getByText("Cycle Source")).toBeTruthy();
    expect(within(item).getByText("com.garmin.connect")).toBeTruthy();
  });

  it("shows neutral HealthKit permission guidance and conflict states", async () => {
    mocks.phase.mockReturnValue({
      data: {
        phase: null,
        dayOfCycle: null,
        cycleLength: null,
        estimate: null,
        latestCycleStart: null,
        availability: {
          status: "no-history",
          label: "No cycle starts are available from provider records.",
        },
      },
      error: null,
      isLoading: false,
    });
    const { default: CycleScreen } = await import("../app/cycle");
    const view = render(<CycleScreen />);
    expect(screen.getByText(/Apple Health permissions/)).toBeTruthy();

    mocks.phase.mockReturnValue({
      data: {
        phase: null,
        dayOfCycle: null,
        cycleLength: null,
        estimate: null,
        latestCycleStart: null,
        availability: {
          status: "conflicting-history",
          label: "Provider cycle-start records conflict: 2026-06-01 and 2026-06-20.",
        },
      },
      error: null,
      isLoading: false,
    });
    view.rerender(<CycleScreen />);
    expect(screen.getByText(/2026-06-01 and 2026-06-20/)).toBeTruthy();
    expect(screen.queryByLabelText("Current cycle day")).toBeNull();
  });

  it("surfaces query errors", async () => {
    mocks.phase.mockReturnValue({
      data: undefined,
      error: new Error("Current cycle query failed."),
      isLoading: false,
    });
    mocks.history.mockReturnValue({
      data: undefined,
      error: new Error("History query failed."),
      isLoading: false,
    });
    const { default: CycleScreen } = await import("../app/cycle");
    render(<CycleScreen />);
    expect(screen.getByText("Current cycle query failed.")).toBeTruthy();
    expect(screen.getByText("History query failed.")).toBeTruthy();
  });

  it("navigates to data-source and privacy controls", async () => {
    const { default: CycleScreen } = await import("../app/cycle");
    render(<CycleScreen />);

    fireEvent.click(screen.getByRole("link", { name: "Data sources" }));
    expect(mocks.push).toHaveBeenCalledWith({
      pathname: "/settings",
      params: { tab: "data-sources" },
    });
    fireEvent.click(screen.getByRole("link", { name: "Export all data" }));
    expect(mocks.push).toHaveBeenCalledWith({
      pathname: "/settings",
      params: { tab: "privacy-export" },
    });
  });
});
