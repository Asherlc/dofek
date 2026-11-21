/** @vitest-environment jsdom */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({
    option,
    empty,
    emptyMessage,
  }: {
    option: { tooltip?: { formatter?: (point: { dataIndex: number }) => string } };
    empty?: boolean;
    emptyMessage?: string;
  }) => (
    <div
      data-testid="estimated-max-chart"
      data-option={JSON.stringify(option)}
      data-empty={String(Boolean(empty))}
      data-empty-message={emptyMessage}
    >
      {empty ? (
        emptyMessage
      ) : (
        <div>{option.tooltip?.formatter?.({ dataIndex: 0 })?.split("<br/>").join(" ")}</div>
      )}
    </div>
  ),
}));

import { EstimatedMaxChart } from "./EstimatedMaxChart.tsx";

const squat = {
  exerciseName: "Barbell Back Squat",
  equipment: null,
  estimatedStrength: {
    exerciseName: "Barbell Back Squat",
    equipment: null,
    history: [
      {
        date: "2026-05-01",
        estimatedMax: 118,
        actualWeight: 100,
        actualReps: 5,
        sourceSetId: "00000000-0000-4000-8000-000000000001",
        provider: "strong-csv",
        fatigueMarker: "Failure" as const,
      },
      {
        date: "2026-07-01",
        estimatedMax: 128,
        actualWeight: 110,
        actualReps: 5,
        sourceSetId: "00000000-0000-4000-8000-000000000002",
        provider: "strong-csv",
        fatigueMarker: "Failure" as const,
      },
    ],
    trend: {
      direction: "increasing" as const,
      summary: "Estimated max increased from first to latest estimate.",
      changeMagnitudeKg: 10,
      firstDate: "2026-05-01",
      latestDate: "2026-07-01",
    },
  },
  exerciseOrder: null,
};

const pullUpBaseline = {
  activityId: "11111111-1111-4111-8111-111111111111",
  date: "2026-05-01",
  position: 2,
  sets: [{ position: 1, resistance: 20, unit: "KG" as const, reps: 5 }],
};

const pullUpEarlier = {
  activityId: "22222222-2222-4222-8222-222222222222",
  date: "2026-06-01",
  position: 1,
  sets: [
    { position: 1, resistance: 25.5, unit: "KG" as const, reps: 5 },
    { position: 2, resistance: 45, unit: "LBS" as const, reps: 3 },
  ],
};

const orderOnlyPullUp = {
  exerciseName: "Weighted Pull Up",
  equipment: null,
  estimatedStrength: null,
  exerciseOrder: {
    source: "Crimpd" as const,
    baseline: pullUpBaseline,
    earlier: pullUpEarlier,
  },
};

const squatWithOrder = {
  ...squat,
  exerciseOrder: {
    source: "Crimpd" as const,
    baseline: {
      activityId: "33333333-3333-4333-8333-333333333333",
      date: "2026-05-20",
      position: 3,
      sets: [{ position: 1, resistance: 100, unit: "KG" as const, reps: 5 }],
    },
    earlier: null,
  },
};

const chartOptionSchema = z.object({
  series: z.array(z.object({ name: z.string() })),
});

function chartOption(): z.infer<typeof chartOptionSchema> {
  const chart = screen.getByTestId("estimated-max-chart");
  return chartOptionSchema.parse(JSON.parse(chart.dataset.option ?? "{}"));
}

function selectorSummary() {
  const trigger = screen.getByText("Exercise").closest("button");
  if (!(trigger instanceof HTMLElement)) throw new Error("Expected exercise selector trigger");
  return trigger;
}

function openSelector() {
  fireEvent.click(selectorSummary());
}

describe("EstimatedMaxChart eligibility and tooltip", () => {
  it("explains the minimum when the chart has no trend", () => {
    render(<EstimatedMaxChart exercises={[]} />);
    expect(
      screen.getByText("A trend needs three workouts with qualifying sets and recorded fatigue."),
    ).toBeInTheDocument();
  });

  it("shows the recorded load, repetitions, and fatigue evidence in the tooltip", () => {
    render(<EstimatedMaxChart exercises={[squat]} />);
    expect(screen.getByText(/Recorded set · 100.0 kg × 5/)).toBeInTheDocument();
    expect(screen.getByText(/Strong set tag · Failure/)).toBeInTheDocument();
  });
});

describe("EstimatedMaxChart exercise selector", () => {
  it("opens a native disclosure, focuses search, filters, and selects with focus returned to the trigger", () => {
    render(<EstimatedMaxChart exercises={[squat, orderOnlyPullUp]} />);

    openSelector();
    const search = screen.getByRole("searchbox", { name: "Search exercises" });
    expect(search).toHaveFocus();
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.change(search, { target: { value: "pull" } });
    expect(screen.queryByRole("button", { name: "Barbell Back Squat" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Weighted Pull Up" }));

    expect(selectorSummary()).toHaveFocus();
    expect(selectorSummary()).toHaveTextContent("Weighted Pull Up");
    expect(selectorSummary()).toHaveAttribute("aria-expanded", "false");
  });

  it("closes with Escape and returns focus to the trigger; no-results message for an unmatched search", () => {
    render(<EstimatedMaxChart exercises={[squat, orderOnlyPullUp]} />);

    openSelector();
    const search = screen.getByRole("searchbox", { name: "Search exercises" });
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No exercises match “zzz”.")).toBeInTheDocument();

    fireEvent.keyDown(search, { key: "Escape" });
    expect(selectorSummary()).toHaveAttribute("aria-expanded", "false");
    expect(selectorSummary()).toHaveFocus();
  });

  it("closes with Escape from an option button and returns focus to the trigger", () => {
    render(<EstimatedMaxChart exercises={[squat, orderOnlyPullUp]} />);

    openSelector();
    fireEvent.keyDown(screen.getByRole("button", { name: "Barbell Back Squat" }), {
      key: "Escape",
    });

    expect(selectorSummary()).toHaveAttribute("aria-expanded", "false");
    expect(selectorSummary()).toHaveFocus();
  });

  it("keeps order-only lifts selectable with an accurate chart empty state", () => {
    render(<EstimatedMaxChart exercises={[squat, orderOnlyPullUp]} />);

    openSelector();
    fireEvent.click(screen.getByRole("button", { name: "Weighted Pull Up" }));

    expect(screen.getByTestId("estimated-max-chart")).toHaveAttribute("data-empty", "true");
    expect(screen.getByTestId("estimated-max-chart")).toHaveAttribute(
      "data-empty-message",
      "A trend needs three workouts with qualifying sets and recorded fatigue.",
    );
    expect(chartOption().series).toHaveLength(0);
  });

  it("does not pair same-name lifts with different equipment", () => {
    render(
      <EstimatedMaxChart
        exercises={[
          {
            ...squat,
            exerciseName: "Chest Press",
            equipment: "FREE-WEIGHT",
            estimatedStrength: {
              ...squat.estimatedStrength,
              exerciseName: "Chest Press",
              equipment: "FREE-WEIGHT",
            },
          },
          { ...orderOnlyPullUp, exerciseName: "Chest Press", equipment: "FREE_WEIGHT" },
        ]}
      />,
    );

    openSelector();
    fireEvent.click(screen.getByRole("button", { name: /FREE_WEIGHT/ }));

    expect(screen.getByTestId("estimated-max-chart")).toHaveAttribute("data-empty", "true");
  });
});

describe("EstimatedMaxChart order evidence", () => {
  it("places the condensed callout above the chart with observed date and position and a closed table", () => {
    render(<EstimatedMaxChart exercises={[squatWithOrder]} />);

    const callout = screen.getByRole("region", { name: "Exercise order evidence" });
    const chart = screen.getByTestId("estimated-max-chart");
    expect(callout.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(callout).toHaveTextContent("May 20, 2026");
    expect(callout).toHaveTextContent("exercise 3");
    expect(callout).toHaveTextContent(/If getting stronger at Barbell Back Squat is a priority/);

    const details = screen.getByText("Set details").closest("details");
    expect(details).not.toHaveAttribute("open");
  });

  it("suggests keeping the lift first when the latest verified position is first", () => {
    render(<EstimatedMaxChart exercises={[orderOnlyPullUp]} />);

    const callout = screen.getByRole("region", { name: "Exercise order evidence" });
    expect(callout).toHaveTextContent(
      "If getting stronger at Weighted Pull Up is a priority, keep it first after warm-up.",
    );
  });

  it("does not suggest keeping first when the latest verified position is later", () => {
    render(<EstimatedMaxChart exercises={[squatWithOrder]} />);

    const callout = screen.getByRole("region", { name: "Exercise order evidence" });
    expect(callout).not.toHaveTextContent("keep it first");
  });

  it("keeps a later recorded set when an earlier set is missing and marks the missing cell unknown", () => {
    const skipped = {
      ...orderOnlyPullUp,
      exerciseOrder: {
        source: "Crimpd" as const,
        baseline: {
          ...pullUpBaseline,
          sets: [
            { position: 1, resistance: 20, unit: "KG" as const, reps: 5 },
            { position: 2, resistance: 22.5, unit: "KG" as const, reps: 5 },
            { position: 3, resistance: 25, unit: "KG" as const, reps: 4 },
          ],
        },
        earlier: {
          ...pullUpEarlier,
          sets: [
            { position: 1, resistance: 25.5, unit: "KG" as const, reps: 5 },
            { position: 3, resistance: 30, unit: "KG" as const, reps: 3 },
          ],
        },
      },
    };
    render(<EstimatedMaxChart exercises={[skipped]} />);

    const table = screen.getByRole("table", { name: "Set-number comparison" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    const setThreeRow = within(table).getByRole("row", { name: /^3 / });
    expect(within(setThreeRow).getByText("25 kg × 4")).toBeInTheDocument();
    expect(within(setThreeRow).getByText("30 kg × 3")).toBeInTheDocument();
    const setTwoRow = within(table).getByRole("row", { name: /^2 / });
    expect(within(setTwoRow).getByText("Not recorded")).toBeInTheDocument();
  });

  it("aligns both sessions by set number with missing cells marked and actual units and reps", () => {
    render(<EstimatedMaxChart exercises={[orderOnlyPullUp]} />);

    const table = screen.getByRole("table", { name: "Set-number comparison" });
    expect(within(table).getByText(/May 1, 2026/)).toBeInTheDocument();
    expect(within(table).getByText(/Jun 1, 2026/)).toBeInTheDocument();
    expect(within(table).getByText("20 kg × 5")).toBeInTheDocument();
    expect(within(table).getByText("25.5 kg × 5")).toBeInTheDocument();
    expect(within(table).getByText("45 lbs × 3")).toBeInTheDocument();
    expect(within(table).getByText("Not recorded")).toBeInTheDocument();
  });

  it("shows the estimated-strength trend summary for a lift with estimates", () => {
    render(<EstimatedMaxChart exercises={[squat]} />);

    expect(
      screen.getByText("Estimated max increased from first to latest estimate."),
    ).toBeVisible();
    expect(screen.getByText("May 1 – Jul 1")).toBeVisible();
  });
});
