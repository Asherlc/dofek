/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";

const mocks = vi.hoisted(() => ({
  analyzeUseQuery: vi.fn(),
  captureException: vi.fn(),
  createUseMutation: vi.fn(),
  deleteUseMutation: vi.fn(),
  listInvalidate: vi.fn(),
  listUseQuery: vi.fn(),
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mocks.captureException,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      lifeEvents: {
        list: {
          invalidate: mocks.listInvalidate,
        },
      },
    }),
    lifeEvents: {
      list: {
        useQuery: mocks.listUseQuery,
      },
      create: {
        useMutation: mocks.createUseMutation,
      },
      delete: {
        useMutation: mocks.deleteUseMutation,
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
    mocks.captureException.mockReset();
    mocks.createUseMutation.mockReset();
    mocks.createUseMutation.mockReturnValue({ error: null, isPending: false, mutate: vi.fn() });
    mocks.deleteUseMutation.mockReset();
    mocks.deleteUseMutation.mockReturnValue({ error: null, isPending: false, mutate: vi.fn() });
    mocks.listInvalidate.mockReset();
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

  it("stacks the Travel Week event and add control on narrow screens", () => {
    mocks.listUseQuery.mockReturnValue({
      data: [{ ...event, id: "event-travel", label: "Travel Week", category: "lifestyle" }],
      error: null,
      isLoading: false,
    });

    render(<LifeEventsPanel />);

    const eventButton = screen.getByRole("button", { name: /Travel Week/i });
    const addButton = screen.getByRole("button", { name: "+ Add event" });
    const eventList = eventButton.parentElement;
    const controls = addButton.parentElement;
    if (!(eventList instanceof HTMLElement) || !(controls instanceof HTMLElement)) {
      throw new Error("Expected life event controls");
    }

    expect(controls.classList).toContain("flex-col");
    expect(controls.classList).toContain("sm:flex-row");
    expect(eventList.classList).toContain("min-w-0");
    expect(addButton.classList).toContain("w-full");
    expect(addButton.classList).toContain("sm:w-auto");
  });

  it("stacks add-form fields and controls on narrow screens", () => {
    render(<LifeEventsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add event" }));

    const typeField = screen.getByText("Type").parentElement;
    const typeChoices = screen.getByRole("button", { name: "One-time" }).parentElement;
    const formGrid = typeField?.parentElement;
    const formActions = screen.getByRole("button", { name: "Cancel" }).parentElement;
    const labelField = screen.getByRole("textbox", { name: "Label" }).parentElement;
    if (
      !(typeChoices instanceof HTMLElement) ||
      !(formGrid instanceof HTMLElement) ||
      !(formActions instanceof HTMLElement) ||
      !(labelField instanceof HTMLElement)
    ) {
      throw new Error("Expected responsive life event form controls");
    }

    expect(formGrid.classList).toContain("grid-cols-1");
    expect(formGrid.classList).toContain("sm:grid-cols-2");
    expect(labelField.classList).toContain("sm:col-span-2");
    expect(typeChoices.classList).toContain("flex-col");
    expect(typeChoices.classList).toContain("sm:flex-row");
    expect(formActions.classList).toContain("flex-col");
    expect(formActions.classList).toContain("sm:flex-row");
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
    const deleteButton = screen.getByRole("button", { name: "Delete" });
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
    expect(deleteButton.classList).toContain("w-full");
    expect(deleteButton.classList).toContain("sm:w-auto");
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
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("shows and reports create failures without clearing the form", () => {
    const createError = new Error("Life event was not saved");
    let onError: ((error: unknown) => void) | undefined;
    let meta: unknown;
    const mutate = vi.fn();
    mocks.createUseMutation.mockImplementation(
      (options: { meta?: unknown; onError?: (error: unknown) => void }) => {
        meta = options.meta;
        onError = options.onError;
        return { error: createError, isPending: false, mutate };
      },
    );

    render(<LifeEventsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add event" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Label" }), {
      target: { value: "Keep this event" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    act(() => onError?.(createError));

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ label: "Keep this event" }));
    expect(meta).toEqual({ errorReportedLocally: true });
    expect(screen.getByText(createError.message)).toBeDefined();
    const label = screen.getByRole("textbox", { name: "Label" });
    expect(label).toBeInstanceOf(HTMLInputElement);
    if (!(label instanceof HTMLInputElement)) {
      throw new Error("Expected life event label input");
    }
    expect(label.value).toBe("Keep this event");
    expect(mocks.captureException).toHaveBeenCalledWith(createError, {
      operation: "lifeEvents.create",
    });
  });

  it("shows and reports delete failures without clearing the selection", () => {
    const deleteError = new Error("Life event could not be deleted");
    let onError: ((error: unknown) => void) | undefined;
    let meta: unknown;
    const mutate = vi.fn();
    mocks.deleteUseMutation.mockImplementation(
      (options: { meta?: unknown; onError?: (error: unknown) => void }) => {
        meta = options.meta;
        onError = options.onError;
        return { error: deleteError, isPending: false, mutate };
      },
    );
    mocks.analyzeUseQuery.mockReturnValue({ data: analysisData, error: null, isLoading: false });

    render(<LifeEventsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Started creatine/i }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    act(() => onError?.(deleteError));

    expect(mutate).toHaveBeenCalledWith({ id: "event-1" });
    expect(meta).toEqual({ errorReportedLocally: true });
    expect(screen.getByText(deleteError.message)).toBeDefined();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDefined();
    expect(mocks.captureException).toHaveBeenCalledWith(deleteError, {
      operation: "lifeEvents.delete",
    });
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
