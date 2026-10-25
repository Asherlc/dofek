import { UnitConverter } from "@dofek/format/units";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
    distanceKm: null,
    distanceState: { status: "missing", reason: "Distance not recorded" },
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
    render(
      <ActivityCard {...baseProps} distanceKm={5.25} distanceState={{ status: "available" }} />,
    );
    expect(screen.getByText("5.25")).toBeTruthy();
    expect(screen.getByText("Distance")).toBeTruthy();
    expect(screen.getByText("km")).toBeTruthy();
  });

  it("shows distance in miles when unit system is imperial", () => {
    render(
      <ActivityCard
        {...baseProps}
        units={new UnitConverter("imperial")}
        distanceKm={5.25}
        distanceState={{ status: "available" }}
      />,
    );
    expect(screen.getByText("3.26")).toBeTruthy();
    expect(screen.getByText("Distance")).toBeTruthy();
    expect(screen.getByText("mi")).toBeTruthy();
  });

  it("preserves a measured zero distance", () => {
    render(<ActivityCard {...baseProps} distanceKm={0} distanceState={{ status: "available" }} />);
    expect(screen.getByText("0.00")).toBeTruthy();
    expect(screen.getByText("Distance")).toBeTruthy();
    expect(screen.getByText("km")).toBeTruthy();
    expect(screen.queryByText("Avg HR")).toBeNull();
  });

  it("renders the server-authored distance reason when unavailable", () => {
    render(
      <ActivityCard
        {...baseProps}
        distanceState={{ status: "processing", reason: "Distance is still processing" }}
      />,
    );
    expect(screen.getByText("Distance processing")).toBeTruthy();
    expect(screen.getByText("Distance is still processing")).toBeTruthy();
    expect(screen.getByLabelText("Distance processing: Distance is still processing")).toBeTruthy();
  });

  it.each([
    ["running", "Running"],
    ["cycling", "Cycling"],
    ["hangboard", "Hangboarding"],
    ["archery", "Archery"],
    ["paddleboarding", "Paddleboarding"],
  ])("renders the shared activity icon for %s", (activityType, label) => {
    render(<ActivityCard {...baseProps} activityType={activityType} />);
    expect(screen.getByLabelText(`${label} activity`).querySelector("SvgXml")).toBeTruthy();
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
