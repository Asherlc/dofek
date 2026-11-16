// @vitest-environment jsdom

import { shiftDateYmd } from "@dofek/format/format";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockSleepData: Record<string, unknown> | undefined;
let mockSleepError: Error | null;
const sleepMocks = vi.hoisted(() => ({ stagesByDate: vi.fn() }));

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
        useQuery: () => ({ data: [], isLoading: false, isFetching: false }),
      },
    },
    sleep: {
      stagesByDate: { useQuery: sleepMocks.stagesByDate },
    },
  },
}));

vi.mock("@react-native-community/datetimepicker", () => ({
  default: ({
    maximumDate,
    onChange,
    value,
  }: {
    maximumDate: Date;
    onChange: (event: { type: string }, date?: Date) => void;
    value: Date;
  }) => (
    <input
      type="date"
      aria-label="Night date"
      max={maximumDate.toISOString().slice(0, 10)}
      value={value.toISOString().slice(0, 10)}
      onChange={(event) =>
        onChange({ type: "set" }, new Date(`${event.currentTarget.value}T12:00:00`))
      }
    />
  ),
}));

vi.mock("../lib/useProcessingStatus", () => ({
  useProcessingStatus: () => ({ data: undefined, error: null, isLoading: false }),
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
  ProcessingStatusWidget: () => null,
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

describe("SleepScreen", () => {
  beforeEach(() => {
    mockSleepData = undefined;
    mockSleepError = null;
    sleepMocks.stagesByDate.mockImplementation((input?: { date?: string }) => ({
      data: { date: input?.date ?? "2026-07-20", stages: [] },
      error: null,
      isError: false,
      isLoading: false,
      isFetching: false,
    }));
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
});
