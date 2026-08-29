/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routeState = vi.hoisted(() => ({ id: "00000000-0000-0000-0000-000000000001" }));
const queryMocks = vi.hoisted(() => ({
  detail: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    to,
    ...props
  }: {
    children: ReactNode;
    params?: { id: string };
    to: string;
  }) => (
    <a {...props} href={params ? to.replace("$id", params.id) : to}>
      {children}
    </a>
  ),
  useParams: () => routeState,
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children, title }: { children: ReactNode; title?: string }) => (
    <main>
      {title ? <h1>{title}</h1> : null}
      {children}
    </main>
  ),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    clinicalRecords: {
      detail: { useQuery: queryMocks.detail },
      list: { useQuery: queryMocks.list },
    },
  },
}));

import { ClinicalRecordDetailPage, ClinicalRecordsPage } from "./clinical-records.tsx";

const summary = {
  id: routeState.id,
  clinicalType: "labResult",
  typeLabel: "Lab result from server",
  displayName: "Wellness panel",
  sourceName: "Review Clinic",
  sourceLabel: "Demo data — synthetic",
  date: "2026-08-28T18:00:00.000Z",
  dateLabel: "Recorded 28 Aug 2026",
  downloadedAt: "2026-08-29T18:00:00.000Z",
  recordedAt: "2026-08-28T18:00:00.000Z",
  issuedAt: null,
} as const;

const detail = {
  ...summary,
  providerId: "apple_health",
  externalId: "review-lab-result",
  fhirVersion: "4.0.1",
  fhir: { resourceType: "Observation", status: "final" },
} as const;

function queryResult<T>(data?: T, overrides: Record<string, unknown> = {}) {
  return {
    data,
    error: null,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

describe("ClinicalRecordsPage", () => {
  beforeEach(() => {
    queryMocks.list.mockReset();
    queryMocks.detail.mockReset();
    queryMocks.list.mockReturnValue(queryResult({ records: [summary], nextOffset: null }));
    queryMocks.detail.mockReturnValue(queryResult(detail));
  });

  afterEach(cleanup);

  it("renders server-authored record labels and links to detail", () => {
    render(<ClinicalRecordsPage />);

    expect(screen.getByText("Lab result from server")).toBeTruthy();
    expect(screen.getByText("Demo data — synthetic")).toBeTruthy();
    expect(screen.getByText("Recorded 28 Aug 2026")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Wellness panel" })).toHaveAttribute(
      "href",
      `/clinical-records/${summary.id}`,
    );
  });

  it("keeps loading, server error, and empty responses distinct", () => {
    queryMocks.list.mockReturnValue(queryResult(undefined, { isLoading: true }));
    const loading = render(<ClinicalRecordsPage />);
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    loading.unmount();

    queryMocks.list.mockReturnValue(
      queryResult(undefined, { error: new Error("Clinical data is unavailable.") }),
    );
    const error = render(<ClinicalRecordsPage />);
    expect(screen.getByText("Clinical data is unavailable.")).toBeTruthy();
    expect(screen.queryByTestId("query-state-empty")).toBeNull();
    error.unmount();

    queryMocks.list.mockReturnValue(queryResult({ records: [], nextOffset: null }));
    render(<ClinicalRecordsPage />);
    expect(screen.getByTestId("query-state-empty")).toHaveTextContent(
      "No clinical records have been synced yet.",
    );
  });

  it("shows a cached-empty refetch error instead of the empty state", () => {
    queryMocks.list.mockReturnValue(
      queryResult(
        { records: [], nextOffset: null },
        { error: new Error("Clinical refresh is unavailable.") },
      ),
    );

    render(<ClinicalRecordsPage />);

    expect(screen.getByText("Clinical refresh is unavailable.")).toBeTruthy();
    expect(screen.queryByTestId("query-state-empty")).toBeNull();
  });

  it("pages with server-provided offsets", () => {
    queryMocks.list.mockReturnValue(queryResult({ records: [summary], nextOffset: 20 }));
    render(<ClinicalRecordsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(queryMocks.list).toHaveBeenLastCalledWith({ limit: 20, offset: 20 });
  });
});

describe("ClinicalRecordDetailPage", () => {
  beforeEach(() => {
    queryMocks.list.mockReset();
    queryMocks.detail.mockReset();
    queryMocks.detail.mockReturnValue(queryResult(detail));
  });

  afterEach(cleanup);

  it("renders server-authored detail labels and read-only FHIR JSON", () => {
    render(<ClinicalRecordDetailPage />);

    expect(screen.getByRole("heading", { name: "Wellness panel" })).toBeTruthy();
    expect(screen.getByText("Lab result from server")).toBeTruthy();
    expect(screen.getByText("Demo data — synthetic")).toBeTruthy();
    expect(screen.getByText("Recorded 28 Aug 2026")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "FHIR resource" })).toBeTruthy();
    expect(screen.getByText(/"resourceType": "Observation"/)).toBeTruthy();
  });

  it("shows the specific detail server error", () => {
    queryMocks.detail.mockReturnValue(
      queryResult(undefined, { error: new Error("Clinical record not found.") }),
    );

    render(<ClinicalRecordDetailPage />);

    expect(screen.getByText("Clinical record not found.")).toBeTruthy();
  });
});
