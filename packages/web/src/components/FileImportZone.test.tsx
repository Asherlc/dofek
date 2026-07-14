// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileImportZone } from "./FileImportZone.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/providers/strong-csv">{children}</a>,
}));

afterEach(cleanup);

describe("FileImportZone", () => {
  it("renders an explicit file picker button", () => {
    render(
      <FileImportZone
        providerId="strong-csv"
        title="Strong"
        description=".csv export from Strong app"
        accept=".csv"
        uploadUrl="/api/upload/strong-csv?units=kg"
        statusUrl="/api/upload/strong-csv/status"
      />,
    );

    expect(screen.getByRole("button", { name: "Import file" })).toBeTruthy();
    expect(screen.getByText(".csv export from Strong app")).toBeTruthy();
  });

  it("renders provider summary totals on file import tiles", () => {
    render(
      <FileImportZone
        providerId="strong-csv"
        title="Strong"
        description=".csv export from Strong app"
        accept=".csv"
        uploadUrl="/api/upload/strong-csv?units=kg"
        statusUrl="/api/upload/strong-csv/status"
        stats={{
          activities: 352,
          metricStream: 205_367,
          dailyMetrics: 229,
          sleepSessions: 155,
          bodyMeasurements: 43,
          healthEvents: 392,
          foodEntries: 0,
          nutritionDaily: 0,
          labPanels: 0,
          labResults: 0,
          journalEntries: 0,
        }}
      />,
    );

    expect(screen.getByText("206,538")).toBeTruthy();
    expect(screen.getByText("records")).toBeTruthy();
    expect(screen.getByText("Activities")).toBeTruthy();
    expect(screen.getByText("352")).toBeTruthy();
    expect(screen.getByText("Metric Stream")).toBeTruthy();
    expect(screen.getByText("205,367")).toBeTruthy();
    expect(screen.getByText("Daily Metrics")).toBeTruthy();
    expect(screen.getByText("229")).toBeTruthy();
    expect(screen.getByText("Sleep")).toBeTruthy();
    expect(screen.getByText("155")).toBeTruthy();
    expect(screen.getByText("Body")).toBeTruthy();
    expect(screen.getByText("43")).toBeTruthy();
    expect(screen.getByText("Events")).toBeTruthy();
    expect(screen.getByText("392")).toBeTruthy();
  });
});
