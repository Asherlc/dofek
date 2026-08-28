// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
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
