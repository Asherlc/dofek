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
  };

  it("renders activity name", () => {
    render(<ActivityCard {...baseProps} />);
    expect(screen.getByText("Morning Run")).toBeTruthy();
  });

  it("falls back to activityType when name is empty", () => {
    render(<ActivityCard {...baseProps} name="" />);
    expect(screen.getByText("running")).toBeTruthy();
  });

  it("shows avg HR when provided", () => {
    render(<ActivityCard {...baseProps} avgHr={152.7} />);
    expect(screen.getByText("153")).toBeTruthy();
    expect(screen.getByText("Avg Heart Rate")).toBeTruthy();
  });

  it("shows max HR when provided", () => {
    render(<ActivityCard {...baseProps} maxHr={178.3} />);
    expect(screen.getByText("178")).toBeTruthy();
    expect(screen.getByText("Max Heart Rate")).toBeTruthy();
  });

  it("shows avg power when provided", () => {
    render(<ActivityCard {...baseProps} avgPower={245.6} />);
    expect(screen.getByText("246")).toBeTruthy();
    expect(screen.getByText("Avg Power")).toBeTruthy();
  });

  it("hides stats when values are null", () => {
    render(<ActivityCard {...baseProps} />);
    expect(screen.queryByText("Avg Heart Rate")).toBeNull();
    expect(screen.queryByText("Max Heart Rate")).toBeNull();
    expect(screen.queryByText("Avg Power")).toBeNull();
  });

  it("shows running icon for run activities", () => {
    render(<ActivityCard {...baseProps} activityType="running" />);
    expect(screen.getByText("\u{1F3C3}")).toBeTruthy();
  });

  it("shows cycling icon for bike activities", () => {
    render(<ActivityCard {...baseProps} activityType="cycling" />);
    expect(screen.getByText("\u{1F6B4}")).toBeTruthy();
  });

  it("shows swim icon for swim activities", () => {
    render(<ActivityCard {...baseProps} activityType="swimming" />);
    expect(screen.getByText("\u{1F3CA}")).toBeTruthy();
  });

  it("shows default icon for unknown activity types", () => {
    render(<ActivityCard {...baseProps} activityType="paddleboarding" />);
    expect(screen.getByText("\u{26A1}")).toBeTruthy();
  });
});
