import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataReadinessBanner, type DataReadinessSnapshot } from "./DataReadinessBanner";

function makeSnapshot(overrides: Partial<DataReadinessSnapshot> = {}): DataReadinessSnapshot {
  return {
    overallStatus: "blocked",
    generatedAt: "2026-06-30T08:00:00.000Z",
    syncingProviders: [],
    datasets: [
      {
        key: "activity",
        label: "Activities",
        rawRows: 15,
        latestRawAt: "2026-06-30T07:00:00.000Z",
        latestReadModelAt: null,
        cdcLagSeconds: null,
        readModelLagSeconds: null,
        status: "blocked",
        message: "Activities data is available, but ClickHouse mirrors are not current.",
      },
    ],
    ...overrides,
  };
}

describe("DataReadinessBanner", () => {
  it("renders nothing while loading or healthy", () => {
    const loading = render(<DataReadinessBanner loading={true} />);
    expect(loading.container.innerHTML).toBe("");

    const healthy = render(
      <DataReadinessBanner data={makeSnapshot({ overallStatus: "healthy", datasets: [] })} />,
    );
    expect(healthy.container.innerHTML).toBe("");
  });

  it("surfaces data-health query errors when no readiness snapshot is available", () => {
    render(<DataReadinessBanner error={new Error("ClickHouse read model query failed")} />);

    expect(screen.getByText("Data readiness is unavailable")).toBeTruthy();
    expect(screen.getByText("ClickHouse read model query failed")).toBeTruthy();
  });

  it("shows blocked server readiness messages", () => {
    render(<DataReadinessBanner data={makeSnapshot()} />);

    expect(screen.getByText("Data pipeline needs attention")).toBeTruthy();
    expect(screen.getByText("Activities")).toBeTruthy();
    expect(
      screen.getByText("Activities data is available, but ClickHouse mirrors are not current."),
    ).toBeTruthy();
  });

  it("shows syncing, stale, and missing headings from the overall status", () => {
    const { rerender } = render(
      <DataReadinessBanner
        data={makeSnapshot({
          overallStatus: "syncing",
          syncingProviders: [{ id: "garmin", name: "Garmin" }],
        })}
      />,
    );
    expect(screen.getByText("Syncing Garmin")).toBeTruthy();

    rerender(<DataReadinessBanner data={makeSnapshot({ overallStatus: "stale" })} />);
    expect(screen.getByText("Dashboard summaries are catching up")).toBeTruthy();

    rerender(<DataReadinessBanner data={makeSnapshot({ overallStatus: "missing" })} />);
    expect(screen.getByText("No data has synced yet")).toBeTruthy();
  });
});
