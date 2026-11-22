// @vitest-environment jsdom

import { shiftDateYmd } from "@dofek/format/format";
import { fireEvent, render, screen } from "@testing-library/react";
import type { CSSProperties } from "react";
import { useWindowDimensions } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockSleepData: Record<string, unknown> | undefined;
let mockSleepError: Error | null;
let mockProcessingError: Error | null;
let mockConsistencyData: Record<string, unknown>[] = [];
const sleepMocks = vi.hoisted(() => ({ stagesByDate: vi.fn(), recorded: vi.fn() }));

vi.mock("../lib/trpc", () => ({
  trpc: {
    recovery: {
      sleepAnalytics: {
        useQuery: () => ({
          data: mockSleepData,
          error: mockSleepError,
          isError: mockSleepError != null,
          isLoading: false,
          isFetching: false,
        }),
      },
      sleepConsistency: {
        useQuery: () => ({ data: mockConsistencyData, isLoading: false, isFetching: false }),
      },
    },
    sleep: {
      stagesByDate: { useQuery: sleepMocks.stagesByDate },
    },
    dailyMetrics: {
      recorded: { useQuery: sleepMocks.recorded },
    },
  },
}));

vi.mock("../lib/units", async () => {
  const { UnitConverter } = await import("@dofek/format/units");
  return { useUnitConverter: () => new UnitConverter("metric") };
});

vi.mock("@react-native-community/datetimepicker", () => ({
  default: ({
    maximumDate,
    onChange,
    style,
    value,
  }: {
    maximumDate: Date;
    onChange: (event: { type: string }, date?: Date) => void;
    style?: CSSProperties | Array<CSSProperties | false | undefined>;
    value: Date;
  }) => (
    <input
      type="date"
      aria-label="Night date"
      max={maximumDate.toISOString().slice(0, 10)}
      style={Array.isArray(style) ? Object.assign({}, ...style) : style}
      value={value.toISOString().slice(0, 10)}
      onChange={(event) =>
        onChange({ type: "set" }, new Date(`${event.currentTarget.value}T12:00:00`))
      }
    />
  ),
}));

vi.mock("../lib/useProcessingStatus", () => ({
  useProcessingStatus: () => ({ data: undefined, error: mockProcessingError, isLoading: false }),
}));

vi.mock("../lib/useTimeRangePreference", async () => {
  const React = await import("react");
  return {
    useTimeRangePreference: () => {
      const [days, setDays] = React.useState(30);
      return { days, setDays };
    },
  };
});

vi.mock("../lib/useHaptic", () => ({
  useHaptic: () => ({ selection: vi.fn() }),
}));

vi.mock("../lib/useRefresh", () => ({
  useRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }),
}));

vi.mock("../components/ProcessingStatusWidget", () => ({
  ProcessingStatusWidget: ({ error }: { error: { message: string } | null }) =>
    error ? <p>{error.message}</p> : null,
}));

vi.mock("../components/charts/Hypnogram", () => ({
  Hypnogram: () => null,
}));

vi.mock("../components/charts/SleepBar", () => ({
  SleepBar: () => null,
}));

vi.mock("../components/charts/SparkLine", () => ({
  SparkLine: ({ data }: { data: (number | null)[] }) => (
    <div
      data-testid="sleep-sparkline"
      data-values={data.map((value) => value ?? "null").join(",")}
    />
  ),
}));

const mockUseWindowDimensions = vi.mocked(useWindowDimensions);

describe("SleepScreen", () => {
  beforeEach(() => {
    mockSleepData = undefined;
    mockSleepError = null;
    mockProcessingError = null;
    mockConsistencyData = [];
    sleepMocks.recorded.mockReturnValue({
      data: undefined,
      error: null,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    mockUseWindowDimensions.mockReturnValue({
      width: 390,
      height: 844,
      scale: 3,
      fontScale: 1,
    });
    sleepMocks.stagesByDate.mockImplementation((input?: { date?: string }) => ({
      data: { date: input?.date ?? "2026-07-20", stages: [] },
      error: null,
      isError: false,
      isLoading: false,
      isFetching: false,
    }));
  });

  it("shows reported sleep duration even when there are no sleep records", async () => {
    sleepMocks.recorded.mockReturnValue({
      data: [
        {
          date: "2026-03-01",
          metric: "sleep_duration_reported",
          value: 27000,
          unit: "s",
          providerId: "intervals.icu",
          sourceName: null,
        },
      ],
      error: null,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);
    expect(sleepMocks.recorded).toHaveBeenCalledWith(expect.objectContaining({ group: "sleep" }));
    expect(screen.getByText("7h 30m")).toBeTruthy();
    expect(screen.getByText("Measurements may include data from Garmin devices.")).toBeTruthy();
  });

  it("shows the server error instead of the empty state when loading fails", async () => {
    mockSleepError = new Error("Sleep analytics are unavailable.");

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    expect(screen.getByText("Sleep analytics are unavailable.")).toBeTruthy();
    expect(screen.queryByText("No sleep records in this period")).toBeNull();
  });

  it("shows one truthful empty state without zero-valued summary measurements", async () => {
    mockSleepData = {
      nightly: [],
      averageSleepMinutes: null,
      averageEfficiencyPercent: null,
    };

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    expect(screen.getByText("No sleep records in this period")).toBeTruthy();
    expect(screen.getByText("Try a longer date range or check your sleep source.")).toBeTruthy();
    expect(screen.queryByText("Average Duration")).toBeNull();
    expect(screen.queryByText("Average Efficiency")).toBeNull();
  });

  it("renders server-computed summary metrics when sleep data exists", async () => {
    mockSleepData = {
      nightly: [
        {
          date: "2026-07-20",
          startedAt: "2026-07-20T05:00:00.000Z",
          endedAt: "2026-07-20T13:00:00.000Z",
          localTimeContext: {
            timezone: null,
            startUtcOffsetMinutes: -420,
            endUtcOffsetMinutes: -420,
            source: "provider_offset",
          },
          durationMinutes: 320,
          sleepMinutes: 300,
          deepPct: 20,
          remPct: 20,
          lightPct: 50,
          awakePct: 10,
          efficiency: 50,
          stagingAvailable: true,
          rollingAvgDuration: 300,
          durationState: { status: "available" },
          sleepState: { status: "available" },
          stageState: { status: "available" },
        },
      ],
      averageSleepMinutes: 455,
      averageEfficiencyPercent: 91.2,
    };

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    expect(screen.getByText("7h 35m")).toBeTruthy();
    expect(screen.getByText("91%")).toBeTruthy();
    expect(screen.queryByText("5h 0m")).toBeNull();
    expect(screen.queryByText("50%")).toBeNull();
    expect(screen.getByRole("button", { name: "View data for Average Duration" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "View data for Average Efficiency" })).toBeTruthy();
  });

  it("keeps missing sleep nights as gaps in the sleep trend", async () => {
    mockSleepData = {
      nightly: [
        {
          date: "2026-07-19",
          startedAt: "2026-07-19T05:00:00.000Z",
          endedAt: "2026-07-19T13:00:00.000Z",
          localTimeContext: {
            timezone: null,
            startUtcOffsetMinutes: 0,
            endUtcOffsetMinutes: 0,
            source: "provider_offset",
          },
          durationMinutes: null,
          sleepMinutes: null,
          deepPct: null,
          remPct: null,
          lightPct: null,
          awakePct: null,
          efficiency: null,
          stagingAvailable: false,
          rollingAvgDuration: null,
          durationState: { status: "missing", reason: "Sleep duration was not recorded." },
          sleepState: { status: "missing", reason: "Sleep duration was not recorded." },
          stageState: { status: "missing", reason: "Sleep stages were not reported." },
        },
        {
          date: "2026-07-20",
          startedAt: "2026-07-20T05:00:00.000Z",
          endedAt: "2026-07-20T13:00:00.000Z",
          localTimeContext: {
            timezone: null,
            startUtcOffsetMinutes: 0,
            endUtcOffsetMinutes: 0,
            source: "provider_offset",
          },
          durationMinutes: 480,
          sleepMinutes: 450,
          deepPct: 20,
          remPct: 20,
          lightPct: 50,
          awakePct: 10,
          efficiency: 93,
          stagingAvailable: true,
          rollingAvgDuration: 480,
          durationState: { status: "available" },
          sleepState: { status: "available" },
          stageState: { status: "available" },
        },
      ],
      averageSleepMinutes: 450,
      averageEfficiencyPercent: 93,
    };

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    expect(screen.getByTestId("sleep-sparkline").getAttribute("data-values")).toBe("null,450");
  });

  it("identifies the most recent night when sleep stages were not reported", async () => {
    const today = new Intl.DateTimeFormat("en-CA").format(new Date());
    mockSleepData = {
      nightly: [
        {
          date: today,
          startedAt: `${today}T08:00:00.000Z`,
          endedAt: `${today}T16:00:00.000Z`,
          localTimeContext: {
            timezone: "UTC",
            startUtcOffsetMinutes: 0,
            endUtcOffsetMinutes: 0,
            source: "provider_timezone",
          },
          durationMinutes: 480,
          sleepMinutes: 480,
          deepPct: null,
          remPct: null,
          lightPct: null,
          awakePct: null,
          efficiency: null,
          stagingAvailable: false,
          rollingAvgDuration: 480,
          durationState: { status: "available" },
          sleepState: { status: "available" },
          stageState: {
            status: "missing",
            reason: "Sleep stages were not reported for this night.",
            nextAction: "Sync sleep data from a source that reports sleep stages.",
          },
        },
      ],
      averageSleepMinutes: 480,
      averageEfficiencyPercent: null,
    };

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    expect(screen.getByText("Partial sleep record")).toBeTruthy();
    expect(screen.getByText("8h 0m recorded")).toBeTruthy();
    expect(screen.getAllByText("Sleep stages were not reported for this night.").length).toBe(2);
  });

  it("renders the server-authored missing duration state without a zero placeholder", async () => {
    const today = new Intl.DateTimeFormat("en-CA").format(new Date());
    mockSleepData = {
      nightly: [
        {
          date: today,
          startedAt: `${today}T08:00:00.000Z`,
          endedAt: `${today}T16:00:00.000Z`,
          localTimeContext: {
            timezone: "UTC",
            startUtcOffsetMinutes: 0,
            endUtcOffsetMinutes: 0,
            source: "provider_timezone",
          },
          durationMinutes: null,
          sleepMinutes: null,
          deepPct: null,
          remPct: null,
          lightPct: null,
          awakePct: null,
          efficiency: null,
          stagingAvailable: false,
          rollingAvgDuration: null,
          durationState: {
            status: "missing",
            reason: "Sleep duration was not recorded.",
            nextAction: "Sync sleep data from a source that reports sleep duration.",
          },
          sleepState: {
            status: "missing",
            reason: "Sleep duration was not recorded.",
            nextAction: "Sync sleep data from a source that reports sleep duration.",
          },
          stageState: {
            status: "missing",
            reason: "Sleep stages were not reported for this night.",
            nextAction: "Sync sleep data from a source that reports sleep stages.",
          },
        },
      ],
      averageSleepMinutes: null,
      averageEfficiencyPercent: null,
    };

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    expect(screen.getAllByText("Sleep duration was not recorded.").length).toBe(2);
    expect(
      screen.getAllByText("Sync sleep data from a source that reports sleep duration.").length,
    ).toBe(2);
    expect(screen.queryByText("0h 0m recorded")).toBeNull();
  });

  it("renders the stored local bedtime and wake time", async () => {
    const today = new Intl.DateTimeFormat("en-CA").format(new Date());
    mockSleepData = {
      nightly: [
        {
          date: today,
          startedAt: `${today}T08:00:00.000Z`,
          endedAt: `${today}T16:00:00.000Z`,
          localTimeContext: {
            timezone: null,
            startUtcOffsetMinutes: -420,
            endUtcOffsetMinutes: -420,
            source: "provider_offset",
          },
          durationMinutes: 480,
          sleepMinutes: 450,
          deepPct: 20,
          remPct: 20,
          lightPct: 50,
          awakePct: 10,
          efficiency: 90,
          stagingAvailable: true,
          rollingAvgDuration: 450,
          durationState: { status: "available" },
          sleepState: { status: "available" },
          stageState: { status: "available" },
        },
      ],
      averageSleepMinutes: 450,
      averageEfficiencyPercent: 90,
    };

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    expect(screen.getByText("1:00 AM – 9:00 AM")).toBeTruthy();
  });

  it("selects the server's latest date and keeps date navigation available without trend data", async () => {
    const today = new Intl.DateTimeFormat("en-CA").format(new Date());
    sleepMocks.stagesByDate.mockImplementation((input?: { date?: string }) => ({
      data: { date: input?.date ?? today, stages: [] },
      error: null,
      isError: false,
      isLoading: false,
      isFetching: false,
    }));

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    expect(sleepMocks.stagesByDate).toHaveBeenCalledWith(undefined);
    expect(screen.getByText("Night’s Stages")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous day" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(screen.getByRole("button", { name: "Next day" }).hasAttribute("disabled")).toBe(true);
  });

  it("requests the selected day and retains navigation for an empty or failed date", async () => {
    const today = new Intl.DateTimeFormat("en-CA").format(new Date());
    const previousDate = shiftDateYmd(today, -1);
    sleepMocks.stagesByDate.mockImplementation((input?: { date?: string }) => ({
      data: input?.date ? { date: input.date, stages: [] } : { date: today, stages: [] },
      error: input?.date === previousDate ? new Error("Stages unavailable") : null,
      isError: input?.date === previousDate,
      isLoading: false,
      isFetching: false,
    }));

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));

    expect(sleepMocks.stagesByDate).toHaveBeenLastCalledWith({ date: previousDate });
    expect(screen.getByRole("button", { name: "Previous day" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("keeps the selected sleep date when the trend range changes", async () => {
    const today = new Intl.DateTimeFormat("en-CA").format(new Date());
    const previousDate = shiftDateYmd(today, -1);
    sleepMocks.stagesByDate.mockImplementation((input?: { date?: string }) => ({
      data: { date: input?.date ?? today, stages: [] },
      error: null,
      isError: false,
      isLoading: false,
      isFetching: false,
    }));

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    fireEvent.click(screen.getByRole("radio", { name: "7d" }));

    expect(sleepMocks.stagesByDate).toHaveBeenLastCalledWith({ date: previousDate });
  });

  it("uses the native date picker selection as the requested sleep date", async () => {
    const today = new Intl.DateTimeFormat("en-CA").format(new Date());
    const selectedDate = shiftDateYmd(today, -2);
    sleepMocks.stagesByDate.mockImplementation((input?: { date?: string }) => ({
      data: { date: input?.date ?? today, stages: [] },
      error: null,
      isError: false,
      isLoading: false,
      isFetching: false,
    }));

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);
    fireEvent.change(screen.getByLabelText("Night date"), {
      target: { value: selectedDate },
    });

    expect(sleepMocks.stagesByDate).toHaveBeenLastCalledWith({ date: selectedDate });
  });

  it("keeps the independently browsed night stages before the grouped trend range", async () => {
    mockSleepData = {
      nightly: [
        {
          date: "2026-07-20",
          startedAt: "2026-07-20T05:00:00.000Z",
          endedAt: "2026-07-20T13:00:00.000Z",
          localTimeContext: {
            timezone: null,
            startUtcOffsetMinutes: -420,
            endUtcOffsetMinutes: -420,
            source: "provider_offset",
          },
          durationMinutes: 320,
          sleepMinutes: 300,
          deepPct: 20,
          remPct: 20,
          lightPct: 50,
          awakePct: 10,
          efficiency: 50,
          stagingAvailable: true,
          rollingAvgDuration: 300,
          durationState: { status: "available" },
          sleepState: { status: "available" },
          stageState: { status: "available" },
        },
      ],
      averageSleepMinutes: 455,
      averageEfficiencyPercent: 91.2,
    };

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    const nightStages = screen.getByText("Night’s Stages");
    const trendRange = screen.getByRole("radiogroup", { name: "Time range" });
    const trendCard = screen.getByText("Average Duration");
    expect(
      nightStages.compareDocumentPosition(trendRange) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      trendRange.compareDocumentPosition(trendCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows one notice when the night and trend queries fail with the same connection error", async () => {
    const connectionMessage = "We couldn't reach the server. Check your connection and try again.";
    mockSleepError = new Error("Failed to fetch");
    sleepMocks.stagesByDate.mockImplementation(() => ({
      data: undefined,
      error: new Error("Network request failed"),
      isError: true,
      isLoading: false,
      isFetching: false,
    }));

    const { default: SleepScreen } = await import("../app/sleep");
    const view = render(<SleepScreen />);

    expect(screen.getAllByText(connectionMessage)).toHaveLength(1);
    expect(screen.queryByText("No sleep records in this period")).toBeNull();
    // A failed analytics query with no cached data must not leave an empty
    // source area behind, but the independently browsable controls stay.
    expect(screen.queryByText("Sleep Sources")).toBeNull();
    expect(screen.getByText("Night’s Stages")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Time range" })).toBeTruthy();

    // A cached *empty* payload is still empty after the grouped offline refresh.
    mockSleepData = { nightly: [], averageSleepMinutes: null, averageEfficiencyPercent: null };
    view.unmount();
    render(<SleepScreen />);

    expect(screen.getAllByText(connectionMessage)).toHaveLength(1);
    expect(screen.queryByText("No sleep records in this period")).toBeNull();
    expect(screen.queryByText("Sleep Sources")).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "Time range" })).toBeTruthy();
  });

  it("keeps the cached sleep source area when the trend shares the connection error", async () => {
    const connectionMessage = "We couldn't reach the server. Check your connection and try again.";
    const today = new Intl.DateTimeFormat("en-CA").format(new Date());
    mockSleepData = {
      nightly: [
        {
          date: today,
          startedAt: `${today}T08:00:00.000Z`,
          endedAt: `${today}T16:00:00.000Z`,
          localTimeContext: {
            timezone: "UTC",
            startUtcOffsetMinutes: 0,
            endUtcOffsetMinutes: 0,
            source: "provider_timezone",
          },
          durationMinutes: 480,
          sleepMinutes: 450,
          deepPct: 20,
          remPct: 20,
          lightPct: 50,
          awakePct: 10,
          efficiency: 90,
          stagingAvailable: true,
          rollingAvgDuration: 450,
          durationState: { status: "available" },
          sleepState: { status: "available" },
          stageState: { status: "available" },
        },
      ],
      averageSleepMinutes: 450,
      averageEfficiencyPercent: 90,
    };
    mockSleepError = new Error("Failed to fetch");
    sleepMocks.stagesByDate.mockImplementation(() => ({
      data: undefined,
      error: new Error("Network request failed"),
      isError: true,
      isLoading: false,
      isFetching: false,
    }));

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    expect(screen.getAllByText(connectionMessage)).toHaveLength(1);
    expect(screen.getByText("Sleep Sources")).toBeTruthy();
    expect(screen.getByText("Recent Nights")).toBeTruthy();
  });

  it("keeps distinct night and trend failures as separate notices", async () => {
    mockSleepError = new Error("Sleep analytics are unavailable.");
    sleepMocks.stagesByDate.mockImplementation(() => ({
      data: undefined,
      error: new Error("Failed to fetch"),
      isError: true,
      isLoading: false,
      isFetching: false,
    }));

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    expect(screen.getByText("Sleep analytics are unavailable.")).toBeTruthy();
    expect(
      screen.getByText("We couldn't reach the server. Check your connection and try again."),
    ).toBeTruthy();
  });

  it("shows one grouped notice and hides the processing copy when night, trend, and processing share a connection error", async () => {
    const connectionMessage = "We couldn't reach the server. Check your connection and try again.";
    mockSleepError = new Error("Failed to fetch");
    mockProcessingError = new Error(connectionMessage);
    sleepMocks.stagesByDate.mockImplementation(() => ({
      data: undefined,
      error: new Error("Network request failed"),
      isError: true,
      isLoading: false,
      isFetching: false,
    }));

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    expect(screen.getAllByText(connectionMessage)).toHaveLength(1);
    expect(screen.getAllByTestId("query-state-error")).toHaveLength(1);
  });

  it("groups the processing failure with the night failure when the trend fails distinctly", async () => {
    const connectionMessage = "We couldn't reach the server. Check your connection and try again.";
    mockSleepError = new Error("Sleep analytics are unavailable.");
    mockProcessingError = new Error(connectionMessage);
    sleepMocks.stagesByDate.mockImplementation(() => ({
      data: undefined,
      error: new Error("Network request failed"),
      isError: true,
      isLoading: false,
      isFetching: false,
    }));

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    expect(screen.getAllByText(connectionMessage)).toHaveLength(1);
    expect(screen.getByText("Sleep analytics are unavailable.")).toBeTruthy();
  });

  it("hides the duplicate refresh failure but keeps cached stages when the night shares the connection error", async () => {
    const connectionMessage = "We couldn't reach the server. Check your connection and try again.";
    mockSleepError = new Error("Failed to fetch");
    mockProcessingError = new Error(connectionMessage);
    sleepMocks.stagesByDate.mockImplementation(() => ({
      data: { date: "2026-07-20", stages: [] },
      error: new Error("Network request failed"),
      isError: true,
      isLoading: false,
      isFetching: false,
    }));

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    expect(screen.getAllByText(connectionMessage)).toHaveLength(1);
    expect(screen.queryByText(/Refresh failed:/)).toBeNull();
    expect(screen.getByText("Night’s Stages")).toBeTruthy();
  });

  it("keeps one compact row with chevron navigation and 44-point targets at the standard text size", async () => {
    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    const controls = screen.getByTestId("night-date-controls");
    expect(controls.style.flexDirection).toBe("row");
    expect(controls.style.flexWrap).toBe("wrap");

    const previous = screen.getByRole("button", { name: "Previous day" });
    const next = screen.getByRole("button", { name: "Next day" });
    const picker = screen.getByLabelText("Night date");
    for (const button of [previous, next]) {
      expect(button.style.minHeight).toBe("44px");
      expect(button.style.minWidth).toBe("44px");
    }
    expect(previous.querySelector('[data-icon="chevron-back"]')).toBeTruthy();
    expect(next.querySelector('[data-icon="chevron-forward"]')).toBeTruthy();
    expect(
      previous.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(picker.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("gives the date picker its own line and keeps both chevrons together at accessibility text sizes", async () => {
    const today = new Intl.DateTimeFormat("en-CA").format(new Date());
    mockUseWindowDimensions.mockReturnValue({
      width: 390,
      height: 844,
      scale: 3,
      fontScale: 2,
    });
    sleepMocks.stagesByDate.mockImplementation((input?: { date?: string }) => ({
      data: { date: input?.date ?? today, stages: [] },
      error: null,
      isError: false,
      isLoading: false,
      isFetching: false,
    }));

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    const controls = screen.getByTestId("night-date-controls");
    const picker = screen.getByLabelText("Night date");
    expect(picker.style.width).toBe("100%");

    const previous = screen.getByRole("button", { name: "Previous day" });
    const next = screen.getByRole("button", { name: "Next day" });
    const nav = previous.parentElement;
    if (!nav) throw new Error("Expected the navigation buttons to be grouped");
    expect(nav).toBe(next.parentElement);
    expect(nav.style.flexDirection).toBe("row");
    expect(picker.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const button of [previous, next]) {
      expect(button.style.minHeight).toBe("44px");
      expect(button.style.minWidth).toBe("44px");
      expect(button.style.width).not.toBe("100%");
      expect(controls.contains(button)).toBe(true);
    }
    expect(previous.querySelector('[data-icon="chevron-back"]')).toBeTruthy();
    expect(next.querySelector('[data-icon="chevron-forward"]')).toBeTruthy();
    expect(next.hasAttribute("disabled")).toBe(true);
  });

  it("wraps consistency stats into paired rows when enlarged values cannot share a line", async () => {
    const today = new Intl.DateTimeFormat("en-CA").format(new Date());
    mockSleepData = {
      nightly: [
        {
          date: today,
          startedAt: `${today}T08:00:00.000Z`,
          endedAt: `${today}T16:00:00.000Z`,
          localTimeContext: {
            timezone: "UTC",
            startUtcOffsetMinutes: 0,
            endUtcOffsetMinutes: 0,
            source: "provider_timezone",
          },
          durationMinutes: 480,
          sleepMinutes: 450,
          deepPct: 20,
          remPct: 20,
          lightPct: 50,
          awakePct: 10,
          efficiency: 90,
          stagingAvailable: true,
          rollingAvgDuration: 450,
          durationState: { status: "available" },
          sleepState: { status: "available" },
          stageState: { status: "available" },
        },
      ],
      averageSleepMinutes: 450,
      averageEfficiencyPercent: 90,
    };
    mockConsistencyData = [
      {
        date: today,
        consistencyScore: 84,
        bedtimeHour: 23.2,
        waketimeHour: 7.1,
      },
    ];

    const { default: SleepScreen } = await import("../app/sleep");
    render(<SleepScreen />);

    const scoreLabel = screen.getByText("Score");
    const stat = scoreLabel.parentElement;
    const row = stat?.parentElement;
    if (!stat || !row) throw new Error("Expected paired consistency stats in a wrapping row");

    expect(row.style.flexWrap).toBe("wrap");
    expect(row.style.gap).toBe("8px");
    expect(stat.style.flexShrink).toBe("1");
    // The value and its label remain paired inside the same stat.
    expect(stat.textContent).toContain("84");
    expect(stat.textContent).toContain("Score");
    expect(screen.getByText("Schedule Consistency")).toBeTruthy();
  });
});
