/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataReadinessBanner, type DataReadinessSnapshot } from "./DataReadinessBanner.tsx";

function makeSnapshot(overrides: Partial<DataReadinessSnapshot> = {}): DataReadinessSnapshot {
  return {
    overallStatus: "stale",
    generatedAt: "2026-06-30T08:00:00.000Z",
    syncingProviders: [],
    datasets: [
      {
        key: "dailyMetrics",
        label: "Daily metrics",
        rawRows: 42,
        latestRawAt: "2026-06-30T07:00:00.000Z",
        latestReadModelAt: "2026-06-30T05:00:00.000Z",
        cdcLagSeconds: 7200,
        readModelLagSeconds: 7200,
        status: "stale",
        message: "Daily metrics data is synced, but dashboard summaries are still catching up.",
      },
      {
        key: "sleep",
        label: "Sleep",
        rawRows: 0,
        latestRawAt: null,
        latestReadModelAt: null,
        cdcLagSeconds: null,
        readModelLagSeconds: null,
        status: "missing",
        message: "No sleep data has been synced yet.",
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

    expect(screen.getByRole("status").textContent).toContain("Data readiness is unavailable");
    expect(screen.getByText("ClickHouse read model query failed")).toBeTruthy();
  });

  it("shows stale server readiness messages without recomputing metrics", () => {
    render(<DataReadinessBanner data={makeSnapshot()} />);

    expect(screen.getByRole("status").textContent).toContain("Dashboard summaries are catching up");
    expect(screen.getByText("Last checked 2026-06-30 08:00 UTC")).toBeTruthy();
    expect(screen.getByText("Daily metrics")).toBeTruthy();
    expect(
      screen.getByText(
        "Daily metrics data is synced, but dashboard summaries are still catching up.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Sleep")).toBeTruthy();
    expect(screen.getByText("No sleep data has been synced yet.")).toBeTruthy();
  });

  it("uses full-width block layout so the banner does not clip in stacked page content", () => {
    render(<DataReadinessBanner data={makeSnapshot()} />);

    const classNames = screen.getByRole("status").className.split(/\s+/);
    expect(classNames).toContain("block");
    expect(classNames).toContain("w-full");
  });

  it("uses blocked, syncing, and missing headings from the overall status", () => {
    const { rerender } = render(
      <DataReadinessBanner data={makeSnapshot({ overallStatus: "blocked" })} />,
    );
    expect(screen.getByText("Data pipeline needs attention")).toBeTruthy();

    rerender(
      <DataReadinessBanner
        data={makeSnapshot({
          overallStatus: "syncing",
          syncingProviders: [{ id: "garmin", name: "Garmin" }],
        })}
      />,
    );
    expect(screen.getByText("Syncing Garmin")).toBeTruthy();

    rerender(
      <DataReadinessBanner
        data={makeSnapshot({
          overallStatus: "syncing",
          syncingProviders: [
            { id: "garmin", name: "Garmin" },
            { id: "whoop", name: "WHOOP" },
            { id: "strava", name: "Strava" },
          ],
        })}
      />,
    );
    expect(screen.getByText("Syncing Garmin, WHOOP, and Strava")).toBeTruthy();

    rerender(<DataReadinessBanner data={makeSnapshot({ overallStatus: "missing" })} />);
    expect(screen.getByText("No data has synced yet")).toBeTruthy();
  });
});
