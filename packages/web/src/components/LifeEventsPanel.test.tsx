/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";

const mocks = vi.hoisted(() => ({
  analyzeUseQuery: vi.fn(),
  listUseQuery: vi.fn(),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    lifeEvents: {
      list: {
        useQuery: mocks.listUseQuery,
      },
      analyze: {
        useQuery: mocks.analyzeUseQuery,
      },
    },
  },
}));

const event = {
  id: "event-1",
  label: "Started creatine",
  started_at: "2026-02-01",
  ended_at: null,
  category: "supplement",
  ongoing: true,
  notes: null,
};

const analysisData = {
  event,
  metrics: [
    { period: "before", days: 30, avg_resting_hr: 58, avg_hrv: 62 },
    { period: "after", days: 30, avg_resting_hr: 57, avg_hrv: 64 },
  ],
  sleep: [
    { period: "before", nights: 29, avg_sleep_min: 430 },
    { period: "after", nights: 30, avg_sleep_min: 445 },
  ],
  bodyComp: [
    { period: "before", measurements: 6, avg_weight: 80 },
    { period: "after", measurements: 7, avg_weight: 79.5 },
  ],
};

const { LifeEventsPanel } = await import("./LifeEventsPanel.tsx");

describe("LifeEventsPanel", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.analyzeUseQuery.mockReset();
    mocks.analyzeUseQuery.mockReturnValue({ data: undefined, error: null, isLoading: false });
    mocks.listUseQuery.mockReset();
    mocks.listUseQuery.mockReturnValue({ data: [event], error: null, isLoading: false });
  });

  it("renders an initial list failure instead of the empty state", () => {
    const refetch = vi.fn();
    mocks.listUseQuery.mockReturnValue({
      data: undefined,
      error: new Error("Life events could not be loaded"),
      isFetching: false,
      isLoading: false,
      refetch,
    });

    render(<LifeEventsPanel />);

    expect(screen.getByText("Life events could not be loaded")).toBeDefined();
    expect(screen.queryByText("No life events yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry life events" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("retains cached events during a background list failure", () => {
    mocks.listUseQuery.mockReturnValue({
      data: [event],
      error: new Error("Life events refresh failed"),
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<LifeEventsPanel />);

    expect(screen.getByRole("button", { name: /Started creatine/i })).toBeDefined();
    expect(screen.getByText("Life events refresh failed")).toBeDefined();
  });

  it("shows analysis for a selected event", () => {
    mocks.listUseQuery.mockReturnValue({
      data: [{ ...event, id: "event-travel", label: "Travel Week", category: "lifestyle" }],
      error: null,
      isLoading: false,
    });
    mocks.analyzeUseQuery.mockReturnValue({ data: analysisData, error: null, isLoading: false });

    render(<LifeEventsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Travel Week/ }));

    expect(screen.getAllByText(/Before/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/After|During|Since/).length).toBeGreaterThan(0);
  });

  it("stacks selected-event analysis controls on narrow screens", () => {
    mocks.analyzeUseQuery.mockReturnValue({ data: analysisData, error: null, isLoading: false });

    render(<LifeEventsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Started creatine/i }));

    const eventHeading = screen.getByRole("heading", { name: /Started creatine/i });
    const eventMetadata = eventHeading.parentElement;
    const analysisHeader = eventMetadata?.parentElement;
    const windowChoices = screen.getByRole("button", { name: "14d" }).parentElement;
    const windowControls = windowChoices?.parentElement;
    const analysisControls = windowControls?.parentElement;

    if (
      !(eventMetadata instanceof HTMLElement) ||
      !(analysisHeader instanceof HTMLElement) ||
      !(windowChoices instanceof HTMLElement) ||
      !(windowControls instanceof HTMLElement) ||
      !(analysisControls instanceof HTMLElement)
    ) {
      throw new Error("Expected responsive selected-event analysis controls");
    }

    expect(analysisHeader.classList).toContain("flex-col");
    expect(analysisHeader.classList).toContain("sm:flex-row");
    expect(eventMetadata.classList).toContain("min-w-0");
    expect(analysisControls.classList).toContain("flex-col");
    expect(analysisControls.classList).toContain("sm:flex-row");
    expect(windowChoices.classList).toContain("grid-cols-4");
    expect(windowChoices.classList).toContain("sm:flex");
  });

  it("paginates life events", () => {
    mocks.listUseQuery.mockReturnValue({
      data: Array.from({ length: 21 }, (_, index) => ({
        ...event,
        id: `event-${index + 1}`,
        label: `Event ${index + 1}`,
      })),
      error: null,
      isLoading: false,
    });

    render(<LifeEventsPanel />);

    expect(screen.getByRole("button", { name: /Event 1Feb/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Event 21Feb/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next life events page" }));

    expect(screen.queryByRole("button", { name: /Event 1Feb/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Event 21Feb/ })).toBeDefined();
  });

  it("shows analysis failures while keeping the selected event", () => {
    const refetch = vi.fn();
    mocks.analyzeUseQuery.mockReturnValue({
      data: undefined,
      error: new Error("Event analysis failed"),
      isFetching: false,
      isLoading: false,
      refetch,
    });

    render(<LifeEventsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Started creatine/i }));

    expect(screen.getByText("Event analysis failed")).toBeDefined();
    expect(screen.getByRole("button", { name: /Started creatine/i })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry event analysis" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("does not show another event with stale selected-event analysis", () => {
    mocks.analyzeUseQuery.mockReturnValue({ data: analysisData, error: null, isLoading: false });
    const { rerender } = render(<LifeEventsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Started creatine/i }));

    mocks.listUseQuery.mockReturnValue({
      data: [{ ...event, id: "event-2", label: "Replacement event" }],
      error: null,
      isLoading: false,
    });
    rerender(<LifeEventsPanel />);

    expect(screen.getByRole("button", { name: /Replacement event/i })).toBeDefined();
    expect(screen.queryByRole("heading", { name: /Replacement event/i })).toBeNull();
  });

  it("formats analyzed body weight with the shared unit formatter", () => {
    mocks.analyzeUseQuery.mockReturnValue({
      data: analysisData,
      error: null,
      isLoading: false,
    });

    render(
      <UnitContext.Provider value={{ unitSystem: "imperial", setUnitSystem: () => {} }}>
        <LifeEventsPanel />
      </UnitContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Started creatine/i }));

    expect(screen.getByText("176.4 lb")).toBeDefined();
    expect(screen.getByText("175.3 lb")).toBeDefined();
    expect(screen.queryByText("[object Object]")).toBeNull();
  });
});
