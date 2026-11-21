// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { StrengthExerciseHistoryRow } from "dofek-server/types";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/units", () => ({
  useUnitConverter: () => ({
    convertWeight: (value: number) => value,
    weightLabel: "kg",
    formatWeight: (value: number) => ({ value, unit: "kg" }),
  }),
}));

import { EstimatedStrengthCard } from "./EstimatedStrengthCard";

const squat: StrengthExerciseHistoryRow = {
  exerciseName: "Barbell Back Squat",
  equipment: null,
  estimatedStrength: {
    exerciseName: "Barbell Back Squat",
    equipment: null,
    history: [
      { date: "2026-05-01", estimatedMax: 118, actualWeight: 100, actualReps: 5 },
      { date: "2026-07-01", estimatedMax: 128, actualWeight: 110, actualReps: 5 },
    ],
    trend: {
      direction: "increasing",
      summary: "Estimated max increased from first to latest estimate.",
      changeMagnitudeKg: 10,
      firstDate: "2026-05-01",
      latestDate: "2026-07-01",
    },
  },
  exerciseOrder: null,
};

const pullUp: StrengthExerciseHistoryRow = {
  exerciseName: "Weighted Pull Up",
  equipment: null,
  estimatedStrength: null,
  exerciseOrder: {
    source: "Crimpd",
    baseline: {
      activityId: "11111111-1111-4111-8111-111111111111",
      date: "2026-05-01",
      position: 2,
      sets: [
        { position: 1, resistance: 20, unit: "KG", reps: 5 },
        { position: 3, resistance: 22.5, unit: "KG", reps: 4 },
      ],
    },
    earlier: {
      activityId: "22222222-2222-4222-8222-222222222222",
      date: "2026-06-01",
      position: 1,
      sets: [
        { position: 1, resistance: 25.5, unit: "KG", reps: 5 },
        { position: 2, resistance: 45, unit: "LBS", reps: 3 },
      ],
    },
  },
};

function renderCard(props: Partial<Parameters<typeof EstimatedStrengthCard>[0]> = {}) {
  return render(
    <EstimatedStrengthCard rows={[squat, pullUp]} loading={false} error={null} {...props} />,
  );
}

function selectorTrigger() {
  return screen.getByRole("button", { name: /^Exercise/ });
}

describe("EstimatedStrengthCard", () => {
  it("opens a labelled exercise selector with search and selects a lift", () => {
    renderCard();

    expect(selectorTrigger().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(selectorTrigger());
    expect(selectorTrigger().getAttribute("aria-expanded")).toBe("true");

    const search = screen.getByRole("textbox", { name: "Search exercises" });
    fireEvent.change(search, { target: { value: "pull" } });
    expect(screen.queryByRole("button", { name: "Barbell Back Squat" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Weighted Pull Up" }));

    expect(selectorTrigger().getAttribute("aria-expanded")).toBe("false");
    expect(selectorTrigger().textContent).toContain("Weighted Pull Up");
  });

  it("shows an accurate empty chart state for an order-only lift", () => {
    renderCard();

    fireEvent.click(selectorTrigger());
    fireEvent.click(screen.getByRole("button", { name: "Weighted Pull Up" }));

    expect(screen.getByText("No estimated max for this lift")).toBeTruthy();
  });

  it("keeps the keep-first advice inside the priority condition", () => {
    renderCard();

    fireEvent.click(selectorTrigger());
    fireEvent.click(screen.getByRole("button", { name: "Weighted Pull Up" }));

    expect(
      screen.getByText(
        "If getting stronger at Weighted Pull Up is a priority, keep it first after warm-up.",
        { exact: false },
      ),
    ).toBeTruthy();
  });

  it("keeps set details closed and aligns sets by number with unknown cells marked", () => {
    renderCard();

    fireEvent.click(selectorTrigger());
    fireEvent.click(screen.getByRole("button", { name: "Weighted Pull Up" }));

    const details = screen.getByRole("button", { name: /Set details/ });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("25.5 kg × 5")).toBeNull();

    fireEvent.click(details);
    const table = screen.getByLabelText("Set-number comparison");
    expect(within(table).getByText("25.5 kg × 5")).toBeTruthy();
    expect(within(table).getByText("45 lbs × 3")).toBeTruthy();
    expect(within(table).getByText("22.5 kg × 4")).toBeTruthy();
    expect(within(table).getAllByText("Not recorded").length).toBeGreaterThan(0);
    expect(within(table).getByText("3")).toBeTruthy();
    expect(screen.getByText(/Rest and effort may differ between sessions/)).toBeTruthy();
  });

  it("keeps the last loaded history visible with a visible message on background refresh failure", () => {
    renderCard({ error: "Network unavailable" });

    expect(screen.getByRole("alert").textContent).toContain("Refresh failed: Network unavailable");
    expect(screen.getByText(/Barbell Back Squat/)).toBeTruthy();
  });

  it("shows the error without history when there is no loaded data", () => {
    renderCard({ rows: [], error: "Network unavailable" });

    expect(screen.getByRole("alert").textContent).toContain("Network unavailable");
    expect(screen.queryByText("No estimated max data")).toBeNull();
  });
});
