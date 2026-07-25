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
