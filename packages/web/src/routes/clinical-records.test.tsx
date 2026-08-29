/** @vitest-environment jsdom */

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  detail: vi.fn(),
  list: vi.fn(),
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

import { ClinicalRecordDetailPage, ClinicalRecordsPage } from "../pages/clinical-records.tsx";
import { Route as clinicalRecordsFileRoute } from "./clinical-records.tsx";

const id = "00000000-0000-0000-0000-000000000001";
const summary = {
  id,
  clinicalType: "labResult",
  typeLabel: "Lab result",
  displayName: "Wellness panel",
  sourceName: "Review Clinic",
  sourceLabel: "Demo data — synthetic",
  date: "2026-08-28T18:00:00.000Z",
  dateLabel: "Recorded 28 Aug 2026",
  downloadedAt: "2026-08-29T18:00:00.000Z",
  recordedAt: "2026-08-28T18:00:00.000Z",
  issuedAt: null,
} as const;

function queryResult<T>(data: T) {
  return {
    data,
    error: null,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  };
}

function renderClinicalRecordsRouter() {
  const layoutComponent = clinicalRecordsFileRoute.options.component;
  if (!layoutComponent) throw new Error("Clinical Records route requires a component");

  const rootRoute = createRootRoute({ component: Outlet });
  const clinicalRecordsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "clinical-records",
    component: layoutComponent,
  });
  const listRoute = createRoute({
    getParentRoute: () => clinicalRecordsRoute,
    path: "/",
    component: ClinicalRecordsPage,
  });
  const detailRoute = createRoute({
    getParentRoute: () => clinicalRecordsRoute,
    path: "$id",
    component: ClinicalRecordDetailPage,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/clinical-records"] }),
    routeTree: rootRoute.addChildren([clinicalRecordsRoute.addChildren([listRoute, detailRoute])]),
  });

  render(<RouterProvider router={router} />);
  return router;
}

describe("Clinical Records routes", () => {
  beforeEach(() => {
    queryMocks.list.mockReset();
    queryMocks.detail.mockReset();
    queryMocks.list.mockReturnValue(queryResult({ records: [summary], nextOffset: null }));
    queryMocks.detail.mockReturnValue(
      queryResult({
        ...summary,
        providerId: "apple_health",
        externalId: "review-lab-result",
        fhirVersion: "4.0.1",
        fhir: { resourceType: "Observation", status: "final" },
      }),
    );
  });

  afterEach(cleanup);

  it("renders record detail after navigating from the list", async () => {
    const router = renderClinicalRecordsRouter();

    fireEvent.click(await screen.findByRole("link", { name: "Wellness panel" }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/clinical-records/${id}`));
    expect(await screen.findByRole("heading", { name: "FHIR resource" })).toBeTruthy();
  });
});
