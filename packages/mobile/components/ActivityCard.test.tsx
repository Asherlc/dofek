import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnitConverter } from "../lib/units";
import { ActivityCard } from "./ActivityCard";

describe("ActivityCard", () => {
  const baseProps = {
    name: "Morning Run",
    activityType: "running",
    startedAt: "2026-03-18T07:00:00Z",
    endedAt: "2026-03-18T07:45:00Z",
    avgHr: null,
    maxHr: null,
    avgPower: null,
    units: new UnitConverter("metric"),
  };

  it("renders activity name", () => {
    render(<ActivityCard {...baseProps} />);
    expect(screen.getByText("Morning Run")).toBeTruthy();
  });

  it("falls back to activityType when name is empty", () => {
    render(<ActivityCard {...baseProps} name="" />);
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("shows avg HR when provided", () => {
    render(<ActivityCard {...baseProps} avgHr={152.7} />);
    expect(screen.getByText("153")).toBeTruthy();
    expect(screen.getByText("Avg HR")).toBeTruthy();
  });

  it("shows max HR when provided", () => {
    render(<ActivityCard {...baseProps} maxHr={178.3} />);
    expect(screen.getByText("178")).toBeTruthy();
    expect(screen.getByText("Max HR")).toBeTruthy();
  });

  it("shows avg power when provided", () => {
    render(<ActivityCard {...baseProps} avgPower={245.6} />);
    expect(screen.getByText("246")).toBeTruthy();
    expect(screen.getByText("Avg Power")).toBeTruthy();
  });

  it("shows distance when provided", () => {
    render(<ActivityCard {...baseProps} distanceKm={5.25} />);
    expect(screen.getByText("5.25")).toBeTruthy();
    expect(screen.getByText("Distance")).toBeTruthy();
    expect(screen.getByText("km")).toBeTruthy();
  });

  it("shows distance in miles when unit system is imperial", () => {
    render(<ActivityCard {...baseProps} units={new UnitConverter("imperial")} distanceKm={5.25} />);
    expect(screen.getByText("3.26")).toBeTruthy();
    expect(screen.getByText("Distance")).toBeTruthy();
    expect(screen.getByText("mi")).toBeTruthy();
  });

  it("hides stats when values are null or zero", () => {
    render(<ActivityCard {...baseProps} distanceKm={0} />);
    expect(screen.queryByText("Distance")).toBeNull();
    expect(screen.queryByText("Avg HR")).toBeNull();
  });

  it("shows specific icons for common activity types", () => {
    const { rerender } = render(<ActivityCard {...baseProps} activityType="running" />);
    expect(screen.getByText("\u{1F3C3}")).toBeTruthy();

    rerender(<ActivityCard {...baseProps} activityType="cycling" />);
    expect(screen.getByText("\u{1F6B4}")).toBeTruthy();

    rerender(<ActivityCard {...baseProps} activityType="hiit" />);
    expect(screen.getByText("\u{1F4A5}")).toBeTruthy();

    rerender(<ActivityCard {...baseProps} activityType="rowing" />);
    expect(screen.getByText("\u{1F6A3}")).toBeTruthy();
  });

  it("shows default icon for unknown activity types", () => {
    render(<ActivityCard {...baseProps} activityType="paddleboarding" />);
    expect(screen.getByText("\u{26A1}")).toBeTruthy();
  });

  it("parses postgres-style space-separated timestamps", () => {
    render(
      <ActivityCard
        {...baseProps}
        startedAt="2026-03-18 07:00:00+00"
        endedAt="2026-03-18 07:45:00+00"
      />,
    );
    // Should NOT show placeholders — timestamps are valid
    expect(screen.queryByText("-- · --")).toBeNull();
  });

  it("falls back to placeholders for invalid timestamps", () => {
    render(<ActivityCard {...baseProps} startedAt="not-a-date" endedAt="still-not-a-date" />);
    expect(screen.getByText("-- · --")).toBeTruthy();
    expect(screen.queryByText("Invalid Date")).toBeNull();
    expect(screen.queryByText("NaNh")).toBeNull();
  });
});
