/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { NextWorkoutRecommendation } from "dofek-server/types";
import { afterEach, describe, expect, it } from "vitest";
import { NextWorkoutCard } from "./NextWorkoutCard.tsx";

function makeRecommendation(
  overrides?: Partial<NextWorkoutRecommendation>,
): NextWorkoutRecommendation {
  return {
    generatedAt: new Date().toISOString(),
    recommendationType: "cardio",
    title: "Easy Zone 2 Run",
    shortBlurb: "Keep it easy today to build aerobic base.",
    readiness: {
      score: 78,
      level: "high",
    },
    rationale: ["Recovery metrics look good", "No hard session yesterday"],
    details: ["30 min Z2 run", "Keep HR below 145"],
    strength: null,
    cardio: {
      focus: "z2",
      durationMinutes: 30,
      targetZones: ["Zone 2"],
      structure: "Steady state",
      lastEnduranceDaysAgo: 2,
    },
    ...overrides,
  };
}

describe("NextWorkoutCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders loading skeleton when loading", () => {
    const { container } = render(<NextWorkoutCard data={undefined} loading={true} />);
    expect(container.querySelector("[class*='animate-spin']")).not.toBeNull();
  });

  it("renders empty state when data is undefined", () => {
    render(<NextWorkoutCard data={undefined} />);
    expect(screen.getByText(/Not enough data for a workout recommendation/)).toBeDefined();
  });

  it("displays the recommendation title", () => {
    render(<NextWorkoutCard data={makeRecommendation()} />);
    expect(screen.getByText("Easy Zone 2 Run")).toBeDefined();
  });

  it("displays the short blurb", () => {
    render(<NextWorkoutCard data={makeRecommendation()} />);
    expect(screen.getByText("Keep it easy today to build aerobic base.")).toBeDefined();
  });

  it("shows recommendation type badge", () => {
    render(<NextWorkoutCard data={makeRecommendation({ recommendationType: "rest" })} />);
    expect(screen.getByText("Rest")).toBeDefined();
  });

  it("capitalizes recommendation type", () => {
    render(<NextWorkoutCard data={makeRecommendation({ recommendationType: "strength" })} />);
    expect(screen.getByText("Strength")).toBeDefined();
  });

  it("shows readiness score and level", () => {
    render(
      <NextWorkoutCard
        data={makeRecommendation({
          readiness: { level: "high", score: 78 },
        })}
      />,
    );
    expect(screen.getByText(/78\/100 \(high\)/)).toBeDefined();
  });

  it("shows Unknown when readiness score is null", () => {
    render(
      <NextWorkoutCard
        data={makeRecommendation({
          readiness: { score: null, level: "unknown" },
        })}
      />,
    );
    expect(screen.getByText(/Unknown/)).toBeDefined();
  });

  it("shows cardio details when present", () => {
    const { container } = render(<NextWorkoutCard data={makeRecommendation()} />);
    const cardioSpan = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent?.includes("Z2") && el.textContent?.includes("30"),
    );
    expect(cardioSpan).not.toBeNull();
  });

  it("shows strength focus muscles when present", () => {
    const data = makeRecommendation({
      recommendationType: "strength",
      strength: {
        focusMuscles: ["Chest", "Triceps"],
        split: "Push",
        targetSets: "12-16 sets",
        lastStrengthDaysAgo: 3,
      },
    });
    render(<NextWorkoutCard data={data} />);
    expect(screen.getByText(/Chest, Triceps/)).toBeDefined();
  });

  it("renders empty state when generatedAt is not today", () => {
    const staleDate = new Date();
    staleDate.setDate(staleDate.getDate() - 2);
    render(<NextWorkoutCard data={makeRecommendation({ generatedAt: staleDate.toISOString() })} />);
    expect(screen.getByText(/Not enough data for a workout recommendation/)).toBeDefined();
  });

  it("opens detail modal on button click", () => {
    const { container } = render(<NextWorkoutCard data={makeRecommendation()} />);
    fireEvent.click(screen.getByText("View Detailed Plan"));
    expect(container.textContent).toContain("30 min Z2 run");
    expect(container.textContent).toContain("Keep HR below 145");
  });

  it("shows rationale in modal", () => {
    const { container } = render(<NextWorkoutCard data={makeRecommendation()} />);
    fireEvent.click(screen.getByText("View Detailed Plan"));
    expect(container.textContent).toContain("Recovery metrics look good");
  });

  it("closes modal on backdrop click", () => {
    const { container } = render(<NextWorkoutCard data={makeRecommendation()} />);
    fireEvent.click(screen.getByText("View Detailed Plan"));
    expect(container.textContent).toContain("Why This");
    const backdrop = screen.getByLabelText("Close recommendation details");
    fireEvent.click(backdrop);
    expect(container.textContent).not.toContain("Why This");
  });
});
