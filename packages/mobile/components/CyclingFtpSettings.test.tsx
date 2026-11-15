import type { QueryKey } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "../lib/query-client";

const mocks = vi.hoisted(() => {
  const settings: {
    data: { ftp: number | null; effectiveFrom: string } | undefined;
    error: Error | null;
    isLoading: boolean;
  } = {
    data: { ftp: 259, effectiveFrom: "2026-10-01" },
    error: null,
    isLoading: false,
  };
  const settingsCache: Record<string, { ftp: number | null; effectiveFrom: string }> = {};
  const history: {
    data: { ftp: number | null; effectiveFrom: string }[] | undefined;
    error: Error | null;
    isLoading: boolean;
  } = {
    data: [
      { ftp: 259, effectiveFrom: "2026-10-01" },
      { ftp: null, effectiveFrom: "2026-09-01" },
    ],
    error: null,
    isLoading: false,
  };
  const suggestions: {
    data:
      | {
          methods: {
            method: string;
            suggested_ftp: number | null;
            evidence: {
              activity_id: string;
              activity_name: string;
              date: string;
              duration_seconds: number;
              power_watts: number;
            } | null;
            limitations: string;
            unavailable_reason: string | null;
          }[];
        }
      | undefined;
    error: Error | null;
    isFetching: boolean;
  } = {
    data: {
      methods: [
        {
          method: "reference_curves",
          suggested_ftp: 200,
          evidence: {
            activity_id: "ride-1",
            activity_name: "Threshold ride",
            date: "2026-11-03",
            duration_seconds: 1200,
            power_watts: 273,
          },
          limitations: "Estimate only.",
          unavailable_reason: null,
        },
        {
          method: "95_percent_best_20_minute",
          suggested_ftp: null,
          evidence: null,
          limitations: "Needs a qualifying effort.",
          unavailable_reason: "No qualifying effort in this date range.",
        },
      ],
    },
    error: null,
    isFetching: false,
  };
  return {
    settings,
    history,
    suggestions,
    settingsQuery: vi.fn(),
    historyQuery: vi.fn(),
    suggestionQuery: vi.fn(),
    refetch: vi.fn(),
    mutate: vi.fn(),
    onSuccess: vi.fn(),
    onError: vi.fn(),
    setData: vi.fn(),
    isPending: false,
    chooseFutureEndDate: false,
    settingsCache,
    invalidations: {
      settings: vi.fn(),
      history: vi.fn(),
      zones: vi.fn(),
      calendarWeekList: vi.fn(),
    },
  };
});

vi.mock("@react-native-community/datetimepicker", () => ({
  default: ({
    accessibilityLabel,
    value,
    onChange,
    maximumDate,
  }: {
    accessibilityLabel: string;
    value: Date;
    onChange: (_event: unknown, value?: Date) => void;
    maximumDate?: Date;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        onClick: () => {
          const chosenDate =
            accessibilityLabel === "End date" && mocks.chooseFutureEndDate
              ? new Date(2026, 11, 1, 12)
              : new Date(value.getFullYear(), value.getMonth(), value.getDate() - 1, 12);
          if (maximumDate && chosenDate.getTime() > maximumDate.getTime()) return;
          onChange({}, chosenDate);
        },
      },
      accessibilityLabel,
    ),
}));
vi.mock("../lib/useTodayQueryDate", () => ({ useTodayQueryDate: () => "2026-11-15" }));
vi.mock("../lib/telemetry", () => ({ captureException: vi.fn() }));
vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      sportSettings: {
        getBySport: { setData: mocks.setData, invalidate: mocks.invalidations.settings },
        history: { invalidate: mocks.invalidations.history },
      },
      activity: { powerZones: { invalidate: mocks.invalidations.zones } },
      calendar: { weekListV2: { invalidate: mocks.invalidations.calendarWeekList } },
    }),
    sportSettings: {
      getBySport: { useQuery: mocks.settingsQuery },
      history: { useQuery: mocks.historyQuery },
      upsert: {
        useMutation: (options: {
          onSuccess: (...args: never[]) => void;
          onError: (error: Error) => void;
        }) => {
          mocks.onSuccess.mockImplementation(options.onSuccess);
          mocks.onError.mockImplementation(options.onError);
          return { mutate: mocks.mutate, isPending: mocks.isPending };
        },
      },
    },
    power: { ftpSuggestions: { useQuery: mocks.suggestionQuery } },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = {
    data: { ftp: 259, effectiveFrom: "2026-10-01" },
    error: null,
    isLoading: false,
  };
  mocks.history = {
    data: [
      { ftp: 259, effectiveFrom: "2026-10-01" },
      { ftp: null, effectiveFrom: "2026-09-01" },
    ],
    error: null,
    isLoading: false,
  };
  mocks.suggestions = {
    data: {
      methods: [
        {
          method: "reference_curves",
          suggested_ftp: 200,
          evidence: {
            activity_id: "ride-1",
            activity_name: "Threshold ride",
            date: "2026-11-03",
            duration_seconds: 1200,
            power_watts: 273,
          },
          limitations: "Estimate only.",
          unavailable_reason: null,
        },
        {
          method: "95_percent_best_20_minute",
          suggested_ftp: null,
          evidence: null,
          limitations: "Needs a qualifying effort.",
          unavailable_reason: "No qualifying effort in this date range.",
        },
      ],
    },
    error: null,
    isFetching: false,
  };
  mocks.settingsCache = {};
  mocks.isPending = false;
  mocks.chooseFutureEndDate = false;
  mocks.refetch.mockResolvedValue({ data: undefined });
  mocks.settingsQuery.mockImplementation((input: { asOfDate: string }) => ({
    ...mocks.settings,
    data: mocks.settingsCache[input.asOfDate] ?? mocks.settings.data,
  }));
  mocks.setData.mockImplementation(
    (input: { asOfDate: string }, data: { ftp: number | null; effectiveFrom: string }) => {
      mocks.settingsCache[input.asOfDate] = data;
    },
  );
  mocks.historyQuery.mockReturnValue(mocks.history);
  mocks.suggestionQuery.mockImplementation((_input: unknown, _options: unknown) => ({
    ...mocks.suggestions,
    refetch: mocks.refetch,
  }));
});
afterEach(cleanup);

function inputValue(): string {
  const input = screen.getByLabelText("FTP watts");
  if (!(input instanceof HTMLInputElement))
    throw new Error("FTP input was not rendered as a text field.");
  return input.value;
}

describe("CyclingFtpSettings", () => {
  it("loads applicable FTP and history, and uses an inclusive 90-day window only when estimated", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings");
    render(<CyclingFtpSettings focusSection />);
    expect(inputValue()).toBe("259");
    expect(mocks.settingsQuery.mock.calls[0]?.[0]).toEqual({
      sport: "cycling",
      asOfDate: "2026-11-15",
    });
    expect(mocks.suggestionQuery).toHaveBeenCalledWith(
      { start_date: "2026-08-18", end_date: "2026-11-15" },
      { enabled: false },
    );
    expect(mocks.refetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect(screen.getByText("Reference curves")).toBeTruthy();
    expect(screen.getByText(/Threshold ride on/)).toBeTruthy();
    expect(screen.getByText("No qualifying effort in this date range.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start date" }));
    fireEvent.click(screen.getByRole("button", { name: "End date" }));
    expect(mocks.suggestionQuery.mock.calls.at(-1)?.[0]).toEqual({
      start_date: "2026-08-17",
      end_date: "2026-11-14",
    });
    expect(mocks.refetch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    expect(mocks.refetch).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Use this value" }));
    expect(inputValue()).toBe("200");
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.invalidations.settings).not.toHaveBeenCalled();
    expect(mocks.invalidations.history).not.toHaveBeenCalled();
    expect(mocks.invalidations.zones).not.toHaveBeenCalled();
    expect(mocks.invalidations.calendarWeekList).not.toHaveBeenCalled();
  });

  it("saves only positive whole watts and acknowledges cached input before refetch", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings");
    const { rerender } = render(<CyclingFtpSettings />);
    fireEvent.change(screen.getByLabelText("FTP watts"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toContain("positive whole number");
    fireEvent.change(screen.getByLabelText("FTP watts"), { target: { value: "240" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      sport: "cycling",
      ftp: 240,
      effectiveFrom: "2026-11-15",
    });
    act(() =>
      mocks.onSuccess(
        {
          id: "record",
          createdAt: "",
          updatedAt: "",
          userId: "user",
          sport: "cycling",
          notes: null,
          thresholdHr: null,
          thresholdPacePerKm: null,
          ftp: 240,
          effectiveFrom: "2026-11-15",
        },
        { sport: "cycling", ftp: 240, effectiveFrom: "2026-11-15" },
      ),
    );
    expect(mocks.setData).toHaveBeenCalledWith(
      { sport: "cycling", asOfDate: "2026-11-15" },
      expect.objectContaining({ ftp: 240 }),
    );
    expect(inputValue()).toBe("240");
    mocks.settings.error = new Error("Settings could not be refreshed");
    rerender(<CyclingFtpSettings />);
    expect(screen.getByRole("alert").textContent).toContain("Settings could not be refreshed");
    expect(inputValue()).toBe("240");
    fireEvent.change(screen.getByLabelText("FTP watts"), { target: { value: "230" } });
    rerender(<CyclingFtpSettings />);
    expect(inputValue()).toBe("230");
    expect(mocks.invalidations.settings).toHaveBeenCalledOnce();
    expect(mocks.invalidations.history).toHaveBeenCalledOnce();
    expect(mocks.invalidations.zones).toHaveBeenCalledOnce();
    expect(mocks.invalidations.calendarWeekList).toHaveBeenCalledOnce();
  });

  it("saves clear as null for the selected date and keeps loading/errors explicit", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings");
    const { rerender } = render(<CyclingFtpSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Use FTP date 2026-10-01" }));
    await waitFor(() =>
      expect(mocks.settingsQuery.mock.calls.at(-1)?.[0]).toEqual({
        sport: "cycling",
        asOfDate: "2026-10-01",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      sport: "cycling",
      ftp: null,
      effectiveFrom: "2026-10-01",
    });
    act(() =>
      mocks.onSuccess(
        {
          id: "record",
          createdAt: "",
          updatedAt: "",
          userId: "user",
          sport: "cycling",
          notes: null,
          thresholdHr: null,
          thresholdPacePerKm: null,
          ftp: null,
          effectiveFrom: "2026-10-01",
        },
        { sport: "cycling", ftp: null, effectiveFrom: "2026-10-01" },
      ),
    );
    expect(mocks.setData).toHaveBeenCalledWith(
      { sport: "cycling", asOfDate: "2026-10-01" },
      expect.objectContaining({ ftp: null }),
    );
    expect(mocks.invalidations.settings).toHaveBeenCalledOnce();
    expect(mocks.invalidations.history).toHaveBeenCalledOnce();
    expect(mocks.invalidations.zones).toHaveBeenCalledOnce();
    expect(mocks.invalidations.calendarWeekList).toHaveBeenCalledOnce();
    expect(inputValue()).toBe("");
    mocks.settings.error = new Error("Settings could not be refreshed");
    rerender(<CyclingFtpSettings />);
    expect(screen.getByRole("alert").textContent).toContain("Settings could not be refreshed");
    expect(inputValue()).toBe("");
    fireEvent.change(screen.getByLabelText("FTP watts"), { target: { value: "230" } });
    rerender(<CyclingFtpSettings />);
    expect(inputValue()).toBe("230");
  });

  it("keeps cached suggestions visible beside a refresh error", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings");
    const { rerender } = render(<CyclingFtpSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    expect(screen.getByText("Reference curves")).toBeTruthy();

    mocks.suggestions.error = new Error("Suggestions could not be refreshed");
    rerender(<CyclingFtpSettings />);
    expect(screen.getByRole("alert").textContent).toContain("Suggestions could not be refreshed");
    expect(screen.getByText("Reference curves")).toBeTruthy();
    expect(screen.getByText(/Threshold ride on/)).toBeTruthy();
    expect(screen.getByText("Estimate only.")).toBeTruthy();
  });

  it("allows a later estimate end date after an older effective date without automatic RPC", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings");
    mocks.chooseFutureEndDate = true;
    render(<CyclingFtpSettings sectionDate="2026-09-01" />);
    expect(mocks.suggestionQuery).toHaveBeenCalledWith(
      { start_date: "2026-06-04", end_date: "2026-09-01" },
      { enabled: false },
    );
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "End date" }));
    expect(mocks.suggestionQuery.mock.calls.at(-1)?.[0]).toEqual({
      start_date: "2026-06-04",
      end_date: "2026-12-01",
    });
    expect(mocks.refetch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    expect(mocks.refetch).toHaveBeenCalledTimes(2);
  });

  it("disables suggestion choices during a pending save", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings");
    const { rerender } = render(<CyclingFtpSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Estimate" }));
    fireEvent.change(screen.getByLabelText("FTP watts"), { target: { value: "240" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    mocks.isPending = true;
    rerender(<CyclingFtpSettings />);

    fireEvent.click(screen.getByRole("button", { name: "Use this value" }));
    expect(inputValue()).toBe("240");
    expect(
      screen.getByRole("button", { name: "Use this value" }).getAttribute("aria-disabled"),
    ).toBe("true");

    mocks.isPending = false;
    act(() =>
      mocks.onSuccess(
        {
          id: "record",
          createdAt: "",
          updatedAt: "",
          userId: "user",
          sport: "cycling",
          notes: null,
          thresholdHr: null,
          thresholdPacePerKm: null,
          ftp: 240,
          effectiveFrom: "2026-11-15",
        },
        { sport: "cycling", ftp: 240, effectiveFrom: "2026-11-15" },
      ),
    );
    expect(inputValue()).toBe("240");
  });

  it("does not replace dirty input during a successful settings refetch", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings");
    const { rerender } = render(<CyclingFtpSettings />);
    fireEvent.change(screen.getByLabelText("FTP watts"), { target: { value: "230" } });
    mocks.settings.data = { ftp: 280, effectiveFrom: "2026-10-01" };
    rerender(<CyclingFtpSettings />);
    expect(inputValue()).toBe("230");
  });

  it("acknowledges a pending save to its date without replacing a newly selected date", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings");
    const { rerender } = render(<CyclingFtpSettings sectionDate="2026-11-15" />);
    fireEvent.change(screen.getByLabelText("FTP watts"), { target: { value: "240" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    mocks.isPending = true;
    rerender(<CyclingFtpSettings sectionDate="2026-10-01" />);
    await waitFor(() =>
      expect(mocks.settingsQuery.mock.calls.at(-1)?.[0]).toEqual({
        sport: "cycling",
        asOfDate: "2026-10-01",
      }),
    );
    expect(inputValue()).toBe("259");

    mocks.isPending = false;
    act(() =>
      mocks.onSuccess(
        {
          id: "record",
          createdAt: "",
          updatedAt: "",
          userId: "user",
          sport: "cycling",
          notes: null,
          thresholdHr: null,
          thresholdPacePerKm: null,
          ftp: 240,
          effectiveFrom: "2026-11-15",
        },
        { sport: "cycling", ftp: 240, effectiveFrom: "2026-11-15" },
      ),
    );
    expect(inputValue()).toBe("259");
    expect(mocks.settingsCache["2026-11-15"]?.ftp).toBe(240);
  });

  it("refreshes inactive inherited FTP and activity-zone cache entries after a save", async () => {
    const { CyclingFtpSettings } = await import("./CyclingFtpSettings");
    const queryClient = createAppQueryClient();
    const settingsKey: QueryKey = [
      ["sportSettings", "getBySport"],
      { input: { sport: "cycling", asOfDate: "2026-06-15" }, type: "query" },
    ];
    const settingsPath: QueryKey = [["sportSettings", "getBySport"]];
    const activityZonesKey: QueryKey = [
      ["activity", "powerZones"],
      { input: { id: "ride-1", powerSourceId: "source-1" }, type: "query" },
    ];
    const activityZonesPath: QueryKey = [["activity", "powerZones"]];
    let serverFtp = 250;
    await queryClient.fetchQuery({
      queryKey: settingsKey,
      queryFn: async () => ({ ftp: serverFtp, effectiveFrom: "2026-06-01" }),
    });
    await queryClient.fetchQuery({
      queryKey: activityZonesKey,
      queryFn: async () => ({ ftp: serverFtp, zones: [] }),
    });
    expect(queryClient.getQueryData<{ ftp: number }>(settingsKey)?.ftp).toBe(250);
    expect(queryClient.getQueryData<{ ftp: number }>(activityZonesKey)?.ftp).toBe(250);
    expect(queryClient.getQueryCache().find({ queryKey: settingsKey })?.getObserversCount()).toBe(
      0,
    );
    expect(
      queryClient.getQueryCache().find({ queryKey: activityZonesKey })?.getObserversCount(),
    ).toBe(0);

    const invalidatePath =
      (queryKey: QueryKey) =>
      (_input?: unknown, filters?: { refetchType?: "active" | "all" | "none" }) =>
        queryClient.invalidateQueries({ queryKey, refetchType: filters?.refetchType });
    mocks.invalidations.settings.mockImplementation(invalidatePath(settingsPath));
    mocks.invalidations.history.mockImplementation(invalidatePath([["sportSettings", "history"]]));
    mocks.invalidations.zones.mockImplementation(invalidatePath(activityZonesPath));
    mocks.invalidations.calendarWeekList.mockImplementation(
      invalidatePath([["calendar", "weekListV2"]]),
    );

    serverFtp = 200;
    render(<CyclingFtpSettings />);
    act(() =>
      mocks.onSuccess(
        {
          id: "record",
          createdAt: "",
          updatedAt: "",
          userId: "user",
          sport: "cycling",
          notes: null,
          thresholdHr: null,
          thresholdPacePerKm: null,
          ftp: 200,
          effectiveFrom: "2026-06-01",
        },
        { sport: "cycling", ftp: 200, effectiveFrom: "2026-06-01" },
      ),
    );

    await waitFor(() => {
      expect(queryClient.getQueryData<{ ftp: number }>(settingsKey)?.ftp).toBe(200);
      expect(queryClient.getQueryData<{ ftp: number }>(activityZonesKey)?.ftp).toBe(200);
    });
    expect(mocks.invalidations.settings).toHaveBeenCalledWith(undefined, {
      refetchType: "all",
    });
    expect(mocks.invalidations.history).toHaveBeenCalledWith(undefined, {
      refetchType: "all",
    });
    expect(mocks.invalidations.zones).toHaveBeenCalledWith(undefined, {
      refetchType: "all",
    });
    expect(mocks.invalidations.calendarWeekList).toHaveBeenCalledWith(undefined, {
      refetchType: "all",
    });
    queryClient.clear();
  });
});
