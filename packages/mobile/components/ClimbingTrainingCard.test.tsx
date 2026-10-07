// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureException } from "../lib/telemetry";
import { ClimbingTrainingCard } from "./ClimbingTrainingCard";
import { climbingProgressionFixture } from "./climbing-progression-test-helpers";

vi.mock("../lib/telemetry", () => ({ captureException: vi.fn() }));
const mockTrainingState: { data: Record<string, unknown> | undefined } = { data: undefined };
function defaultMockTrainingData() {
  return {
    climbing: {
      gradeProgression: [],
      volumeByGrade: [],
      sessionSummary: [],
      hangboarding: {
        sessionCount: 0,
        totalDurationSeconds: 0,
        averageDurationSeconds: null,
        totalWorkDurationSeconds: null,
        totalRestDurationSeconds: null,
        workIntervalCount: null,
        averageHeartRate: null,
        peakHeartRate: null,
        latestSession: null,
        daily: [],
      },
    },
  };
}

describe("ClimbingTrainingCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrainingState.data = defaultMockTrainingData();
  });
  it("renders server-provided climbing grade progression, volume, and sessions", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      climbing: {
        gradeProgression: [climbingProgressionFixture()],
        volumeByGrade: [
          {
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V4",
            gradeSortValue: 4,
            attempts: 8,
            recordedAttempts: 8,
            sends: 5,
          },
        ],
        sessionSummary: [
          {
            activityId: "activity-1",
            date: "2026-07-09",
            name: "Kaya climbing at Touchstone Pacific Pipe",
            locationName: "Touchstone Pacific Pipe",
            attempts: 8,
            sends: 5,
            hardestBoulderGrade: "V4",
            hardestBoulderGradeSortValue: 4,
            hardestRouteGrade: null,
            hardestRouteGradeSortValue: null,
          },
        ],
      },
    };

    render(<ClimbingTrainingCard data={mockTrainingState.data?.climbing} />);

    expect(screen.getByText("Climbing")).toBeTruthy();
    expect(screen.getByText("Bouldering")).toBeTruthy();
    expect(screen.getAllByText("V4").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("8 attempts")).toBeTruthy();
    expect(screen.getByText("5 sends")).toBeTruthy();
    expect(screen.getByText("Kaya climbing at Touchstone Pacific Pipe")).toBeTruthy();
  });

  it("reports malformed climbing rows while rendering valid partial climbing data", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      climbing: {
        gradeProgression: [climbingProgressionFixture()],
        volumeByGrade: [{ climbType: "boulder", grade: "V4", gradeSortValue: "bad" }],
        sessionSummary: [],
      },
    };

    render(<ClimbingTrainingCard data={mockTrainingState.data?.climbing} />);

    expect(screen.getByText("Bouldering")).toBeTruthy();
    expect(screen.getByText("V4")).toBeTruthy();
    expect(screen.getByText("Climbing data could not be loaded. Please try again.")).toBeTruthy();
    expect(screen.queryByText(/Zod parse failed/)).toBeNull();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      context: "strain:climbing.volumeByGrade",
      zodError: expect.any(Object),
    });
  });

  it("omits unknown grade attempts while retaining sends, recorded zero attempts, and sessions", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      climbing: {
        gradeProgression: [],
        volumeByGrade: [
          {
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "VB",
            gradeSortValue: -1,
            attempts: null,
            recordedAttempts: null,
            sends: 1,
          },
          {
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V0",
            gradeSortValue: 0,
            attempts: 0,
            recordedAttempts: 0,
            sends: 0,
          },
        ],
        sessionSummary: [
          {
            activityId: "activity-1",
            date: "2026-07-09",
            name: "Kaya climbing",
            locationName: "Touchstone Pacific Pipe",
            attempts: null,
            sends: 6,
            hardestBoulderGrade: "V4",
            hardestBoulderGradeSortValue: 4,
            hardestRouteGrade: null,
            hardestRouteGradeSortValue: null,
          },
        ],
      },
    };
    render(<ClimbingTrainingCard data={mockTrainingState.data?.climbing} />);

    const unknownGrade = screen.getByText("VB").parentElement;
    expect(unknownGrade?.textContent).toBe("VB1 sends");
    expect(screen.getByText("0 attempts")).toBeTruthy();
    expect(screen.getByText("0 sends")).toBeTruthy();
    expect(screen.getByText("Kaya climbing")).toBeTruthy();
    expect(screen.getByText("— attempts · 6 sends")).toBeTruthy();
  });

  it("renders recorded climbing attempt subtotals while complete totals are unknown", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      climbing: {
        ...defaultMockTrainingData().climbing,
        volumeByGrade: [
          {
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "VB",
            gradeSortValue: -1,
            attempts: null,
            recordedAttempts: 4,
            sends: 1,
          },
          {
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V0",
            gradeSortValue: 0,
            attempts: null,
            recordedAttempts: 0,
            sends: 0,
          },
        ],
      },
    };
    render(<ClimbingTrainingCard data={mockTrainingState.data?.climbing} />);

    expect(screen.getByText("4 recorded attempts")).toBeTruthy();
    expect(screen.getByText("1 sends")).toBeTruthy();
    expect(screen.getByText("0 recorded attempts")).toBeTruthy();
  });

  it("renders server-computed Hangboarding summary metrics and duration trend", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      climbing: {
        ...defaultMockTrainingData().climbing,
        hangboarding: {
          sessionCount: 2,
          totalDurationSeconds: 1500,
          averageDurationSeconds: 750,
          totalWorkDurationSeconds: 17,
          totalRestDurationSeconds: 103,
          workIntervalCount: 2,
          averageHeartRate: 125,
          peakHeartRate: 150,
          latestSession: {
            activityId: "activity-2",
            startedAt: "2026-08-08T14:00:00.000Z",
            planName: "7/3 Repeaters",
            boardName: "Tension Board",
            durationSeconds: 900,
          },
          daily: [
            {
              date: "2026-08-07",
              sessionCount: 1,
              durationSeconds: 600,
              workDurationSeconds: 7,
              restDurationSeconds: 53,
            },
            {
              date: "2026-08-08",
              sessionCount: 1,
              durationSeconds: 900,
              workDurationSeconds: 10,
              restDurationSeconds: 50,
            },
          ],
        },
      },
    };

    render(<ClimbingTrainingCard data={mockTrainingState.data?.climbing} />);

    for (const label of [
      "Sessions",
      "Total Time",
      "Avg Session",
      "Work Time",
      "Rest Time",
      "Work Intervals",
      "Avg Heart Rate",
      "Peak Heart Rate",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("25m")).toBeTruthy();
    expect(screen.getByText("13m")).toBeTruthy();
    expect(screen.getByText("17s")).toBeTruthy();
    expect(screen.getByText("2m")).toBeTruthy();
    expect(screen.getByText("125 bpm")).toBeTruthy();
    expect(screen.getByText("150 bpm")).toBeTruthy();
    expect(screen.getByText("7/3 Repeaters")).toBeTruthy();
    expect(screen.getByText("Tension Board")).toBeTruthy();
    expect(screen.getByText("15m")).toBeTruthy();
    expect(screen.getByText(/2026/)).toBeTruthy();
  });

  it("shows the Hangboarding empty state", async () => {
    render(<ClimbingTrainingCard data={mockTrainingState.data?.climbing} />);

    expect(screen.getByText("No Hangboarding sessions to display.")).toBeTruthy();
  });

  it("reports malformed Hangboarding daily rows while rendering valid summary metrics", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      climbing: {
        ...defaultMockTrainingData().climbing,
        hangboarding: {
          ...defaultMockTrainingData().climbing.hangboarding,
          sessionCount: 1,
          totalDurationSeconds: 600,
          averageDurationSeconds: 600,
          daily: [{ date: "bad", sessionCount: "bad", durationSeconds: 600 }],
        },
      },
    };

    render(<ClimbingTrainingCard data={mockTrainingState.data?.climbing} />);

    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("Climbing data could not be loaded. Please try again.")).toBeTruthy();
    expect(screen.queryByText(/Zod parse failed/)).toBeNull();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      context: "strain:climbing.hangboarding.daily",
      zodError: expect.any(Object),
    });
  });

  it("renders climbing empty states from empty server arrays", async () => {
    render(<ClimbingTrainingCard data={mockTrainingState.data?.climbing} />);

    expect(screen.getByText("No recorded climbing grades")).toBeTruthy();
    expect(screen.getByText("No climbing volume by grade")).toBeTruthy();
    expect(screen.getByText("No climbing sessions")).toBeTruthy();
  });
});
