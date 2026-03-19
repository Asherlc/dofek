import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MetricCard } from "./MetricCard";

describe("MetricCard", () => {
  it("renders title and value", () => {
    render(<MetricCard title="Heart Rate Variability" value="62" />);
    expect(screen.getByText("Heart Rate Variability")).toBeTruthy();
    expect(screen.getByText("62")).toBeTruthy();
  });

  it("renders unit when provided", () => {
    render(<MetricCard title="HRV" value="62" unit="ms" />);
    expect(screen.getByText("ms")).toBeTruthy();
  });

  it("hides unit when not provided", () => {
    render(<MetricCard title="Score" value="85" />);
    expect(screen.queryByText("ms")).toBeNull();
  });

  it("shows up arrow for upward trend", () => {
    render(<MetricCard title="HRV" value="62" trendDirection="up" />);
    expect(screen.getByText("\u2191")).toBeTruthy();
  });

  it("shows down arrow for downward trend", () => {
    render(<MetricCard title="HRV" value="62" trendDirection="down" />);
    expect(screen.getByText("\u2193")).toBeTruthy();
  });

  it("shows stable arrow for stable trend", () => {
    render(<MetricCard title="HRV" value="62" trendDirection="stable" />);
    expect(screen.getByText("\u2192")).toBeTruthy();
  });

  it("hides trend arrow when no direction given", () => {
    render(<MetricCard title="HRV" value="62" />);
    expect(screen.queryByText("\u2191")).toBeNull();
    expect(screen.queryByText("\u2193")).toBeNull();
    expect(screen.queryByText("\u2192")).toBeNull();
  });

  it("renders subtitle when provided", () => {
    render(<MetricCard title="Stress" value="1.2" subtitle="Trend: improving" />);
    expect(screen.getByText("Trend: improving")).toBeTruthy();
  });

  it("hides subtitle when not provided", () => {
    render(<MetricCard title="Stress" value="1.2" />);
    expect(screen.queryByText(/Trend/)).toBeNull();
  });
});
