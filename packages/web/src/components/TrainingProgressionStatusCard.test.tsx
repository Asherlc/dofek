/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TrainingProgressionStatusCard } from "./TrainingProgressionStatusCard.tsx";

afterEach(cleanup);

describe("TrainingProgressionStatusCard", () => {
  it("shows the Ready to progress badge with the headline and evidence summary", () => {
    render(
      <TrainingProgressionStatusCard
        status="ready"
        headline="Bench press · Barbell"
        summary="More reps at the same weight"
      />,
    );
    expect(screen.getByText("Ready to progress")).toBeTruthy();
    expect(screen.getByText("Bench press · Barbell")).toBeTruthy();
    expect(screen.getByText("More reps at the same weight")).toBeTruthy();
  });

  it("shows the Stagnating badge", () => {
    render(
      <TrainingProgressionStatusCard
        status="stagnating"
        headline="Squat · Barbell"
        summary="Estimated strength held steady across 7 comparable sessions."
      />,
    );
    expect(screen.getByText("Stagnating")).toBeTruthy();
    expect(
      screen.getByText("Estimated strength held steady across 7 comparable sessions."),
    ).toBeTruthy();
  });

  it("omits the badge when there is no readiness status", () => {
    render(
      <TrainingProgressionStatusCard
        status={null}
        headline="Bench press · Barbell"
        summary="More reps at the same weight"
      />,
    );
    expect(screen.queryByText("Ready to progress")).toBeNull();
    expect(screen.queryByText("Stagnating")).toBeNull();
    expect(screen.getByText("More reps at the same weight")).toBeTruthy();
  });

  it("renders disclosed evidence and an optional link alongside the status", () => {
    render(
      <TrainingProgressionStatusCard
        status="ready"
        headline="Overview"
        summary="Ready to progress"
        details={<p>Nov 20, 2026 · 60 kg · 10 reps</p>}
        action={<a href="/training/strength">See strength evidence</a>}
      />,
    );
    expect(screen.getByText("Nov 20, 2026 · 60 kg · 10 reps")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See strength evidence" })).toBeTruthy();
  });
});
