// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecordsBrowser, SyncHistory } from "./provider-detail-data.tsx";

const mocks = vi.hoisted(() => ({
  availableDataTypesUseQuery: vi.fn(),
  logFilterOptionsUseQuery: vi.fn(),
  logsUseQuery: vi.fn(),
  recordFilterOptionsUseQuery: vi.fn(),
  recordsUseQuery: vi.fn(),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    providerDetail: {
      availableDataTypes: {
        useQuery: mocks.availableDataTypesUseQuery,
      },
      recordFilterOptions: {
        useQuery: mocks.recordFilterOptionsUseQuery,
      },
      records: {
        useQuery: mocks.recordsUseQuery,
      },
      logFilterOptions: {
        useQuery: mocks.logFilterOptionsUseQuery,
      },
      logs: {
        useQuery: mocks.logsUseQuery,
      },
    },
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params, to }: { children: string; params?: { id: string }; to: string }) => (
    <a href={params ? to.replace("$id", params.id) : to}>{children}</a>
  ),
}));

describe("RecordsBrowser", () => {
  beforeEach(() => {
    mocks.availableDataTypesUseQuery.mockReset();
    mocks.availableDataTypesUseQuery.mockReturnValue({
      data: ["activities", "sleepSessions"],
      isError: false,
      isLoading: false,
      error: null,
    });
    mocks.recordFilterOptionsUseQuery.mockReset();
    mocks.recordFilterOptionsUseQuery.mockReturnValue({ data: {} });
    mocks.recordsUseQuery.mockReset();
    mocks.recordsUseQuery.mockReturnValue({
      data: { rows: [], columns: [], filterColumns: [] },
      isError: false,
      isLoading: false,
      error: null,
    });
    mocks.logFilterOptionsUseQuery.mockReset();
    mocks.logFilterOptionsUseQuery.mockReturnValue({ data: {} });
    mocks.logsUseQuery.mockReset();
    mocks.logsUseQuery.mockReturnValue({
      data: [],
      isError: false,
      isLoading: false,
      error: null,
    });
  });

  it("exposes record types as tabs with the active type selected", () => {
    render(<RecordsBrowser providerId="wahoo" stats={undefined} />);

    expect(screen.getByRole("tablist", { name: "Record types" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Activities" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Sleep" })).toHaveAttribute("aria-selected", "false");
  });

  it("shows a records loading state while data-type availability is loading", () => {
    mocks.availableDataTypesUseQuery.mockReturnValue({
      data: undefined,
      isError: false,
      isLoading: true,
      error: null,
    });

    render(<RecordsBrowser providerId="wahoo" stats={undefined} />);

    expect(screen.getByText("Loading records...")).toBeTruthy();
  });

  it("shows an availability error instead of an empty-records state", () => {
    mocks.availableDataTypesUseQuery.mockReturnValue({
      data: undefined,
      isError: true,
      isLoading: false,
      error: new Error("Record types are unavailable."),
    });

    render(<RecordsBrowser providerId="wahoo" stats={undefined} />);

    expect(screen.getByText("Record types are unavailable.")).toBeTruthy();
    expect(screen.queryByText("No records yet for this provider.")).toBeNull();
  });

  it("shows the no-records state when the provider has no available data types", () => {
    mocks.availableDataTypesUseQuery.mockReturnValue({
      data: [],
      isError: false,
      isLoading: false,
      error: null,
    });

    render(<RecordsBrowser providerId="wahoo" stats={undefined} />);

    expect(screen.getByText("No records yet for this provider.")).toBeTruthy();
  });

  it("shows the records table loading state after selecting an available data type", () => {
    mocks.recordsUseQuery.mockReturnValue({
      data: undefined,
      isError: false,
      isLoading: true,
      error: null,
    });

    render(<RecordsBrowser providerId="wahoo" stats={undefined} />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
  });

  it("shows the records table error after data-type availability succeeds", () => {
    mocks.recordsUseQuery.mockReturnValue({
      data: undefined,
      isError: true,
      isLoading: false,
      error: new Error("Records could not be loaded."),
    });

    render(<RecordsBrowser providerId="wahoo" stats={undefined} />);

    expect(screen.getByText("Records could not be loaded.")).toBeTruthy();
  });

  it("renders available record data, raw details, stats, and a full-page control", () => {
    mocks.recordsUseQuery.mockReturnValue({
      data: {
        rows: Array.from({ length: 25 }, (_, index) => ({
          id: `activity-${index + 1}`,
          name: `Activity ${index + 1}`,
          raw: { provider: "wahoo", sequence: index + 1 },
        })),
        columns: ["id", "name"],
        filterColumns: ["name"],
      },
      isError: false,
      isLoading: false,
      error: null,
    });

    render(
      <RecordsBrowser
        providerId="wahoo"
        stats={{
          activities: 25,
          bodyMeasurements: 0,
          dailyMetrics: 0,
          foodEntries: 0,
          healthEvents: 0,
          journalEntries: 0,
          clinicalRecords: 0,
          metricStream: 0,
          nutritionDaily: 0,
          sleepSessions: 0,
        }}
      />,
    );

    expect(screen.getByRole("tab", { name: "Activities(25)" })).toBeTruthy();
    const viewButtons = screen.getAllByRole("button", { name: "View" });
    expect(viewButtons).toHaveLength(25);
    expect(screen.getByRole("columnheader", { name: "Data" })).toBeTruthy();
    const nextButton = screen.getByRole("button", { name: "Next" });
    expect(nextButton).not.toBeDisabled();

    const firstViewButton = viewButtons[0];
    if (!firstViewButton) throw new Error("Expected the first record's view button");
    fireEvent.click(firstViewButton);

    expect(screen.getByRole("dialog")).toHaveTextContent("Raw Provider Data");
    expect(screen.getByRole("link", { name: "Open activity" })).toHaveAttribute(
      "href",
      "/activity/activity-1",
    );
  });

  it("links Apple Health records to the clinical records list when records exist", () => {
    render(
      <RecordsBrowser
        providerId="apple_health"
        stats={{
          activities: 0,
          bodyMeasurements: 0,
          clinicalRecords: 1,
          dailyMetrics: 0,
          foodEntries: 0,
          healthEvents: 0,
          journalEntries: 0,
          metricStream: 0,
          nutritionDaily: 0,
          sleepSessions: 0,
        }}
      />,
    );

    expect(screen.getByRole("link", { name: "View clinical records" })).toHaveAttribute(
      "href",
      "/clinical-records",
    );
  });
});

describe("SyncHistory", () => {
  beforeEach(() => {
    mocks.logFilterOptionsUseQuery.mockReset();
    mocks.logFilterOptionsUseQuery.mockReturnValue({ data: {} });
    mocks.logsUseQuery.mockReset();
    mocks.logsUseQuery.mockReturnValue({
      data: [],
      isError: false,
      isLoading: false,
      error: null,
    });
  });

  it("shows a loading state while the first sync-history response is pending", () => {
    mocks.logsUseQuery.mockReturnValue({
      data: undefined,
      isError: false,
      isLoading: true,
      error: null,
    });

    render(<SyncHistory providerId="wahoo" providerName="Wahoo" />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.queryByText("No sync history yet.")).toBeNull();
  });

  it("shows a sync-history error instead of an empty state", () => {
    mocks.logsUseQuery.mockReturnValue({
      data: undefined,
      isError: true,
      isLoading: false,
      error: new Error("Sync history could not be loaded."),
    });

    render(<SyncHistory providerId="wahoo" providerName="Wahoo" />);

    expect(screen.getByText("Sync history could not be loaded.")).toBeTruthy();
    expect(screen.queryByText("No sync history yet.")).toBeNull();
  });
});
