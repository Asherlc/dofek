// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockQueryResult<TData> = {
  data: TData | undefined;
  isLoading: boolean;
  error: Error | null;
};

const mockDataHealthQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<unknown>>(() => ({ data: undefined, isLoading: false, error: null })),
);

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    sync: {
      providers: {
        useQuery: () => ({
          data: [
            {
              id: "garmin",
              name: "Garmin",
              authorized: true,
              authType: "custom:garmin",
              importOnly: false,
              pushOnly: false,
              needsReauth: false,
            },
          ],
          isLoading: false,
        }),
      },
      providerStats: { useQuery: () => ({ data: [], isLoading: false }) },
      logs: { useQuery: () => ({ data: [], isLoading: false }) },
      activeSyncs: { useQuery: () => ({ data: [], isLoading: false }) },
      dataHealth: { useQuery: mockDataHealthQuery },
      triggerSync: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
      syncStatus: { fetch: vi.fn() },
    },
    useUtils: () => ({
      invalidate: vi.fn(),
      sync: {
        providers: { invalidate: vi.fn() },
        syncStatus: { fetch: vi.fn() },
      },
    }),
  },
}));

vi.mock("./DataSourcesAuthModals.tsx", () => ({
  CredentialAuthModal: ({ providerName }: { providerName: string }) => (
    <div>{providerName} credentials</div>
  ),
  GarminAuthModal: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      Garmin auth
    </button>
  ),
  WhoopAuthModal: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      WHOOP auth
    </button>
  ),
}));

vi.mock("./FileImportZone.tsx", () => ({
  FileImportZone: ({ title }: { title: string }) => <section>{title}</section>,
}));

vi.mock("./SyncProviderCard.tsx", () => ({
  SyncProviderCard: ({ provider }: { provider: { name: string } }) => (
    <section>{provider.name}</section>
  ),
}));

vi.mock("../lib/poll-sync-job.ts", () => ({
  pollSyncJob: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/providers/garmin">{children}</a>,
}));

import { DataSourcesPanel } from "./DataSourcesPanel.tsx";

afterEach(cleanup);

describe("DataSourcesPanel", () => {
  beforeEach(() => {
    mockDataHealthQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
  });

  it("shows server data readiness messages above provider cards", () => {
    mockDataHealthQuery.mockReturnValue({
      data: {
        overallStatus: "blocked",
        generatedAt: "2026-06-30T08:00:00.000Z",
        datasets: [
          {
            key: "activity",
            label: "Activities",
            rawRows: 120,
            latestRawAt: "2026-06-30T07:00:00.000Z",
            latestReadModelAt: "2026-06-29T07:00:00.000Z",
            cdcLagSeconds: 60,
            readModelLagSeconds: 86400,
            status: "blocked",
            message: "Activities are synced, but activity summaries need attention.",
          },
        ],
      },
      isLoading: false,
      error: null,
    });

    render(<DataSourcesPanel />);

    const readiness = screen.getByText("Data pipeline needs attention");
    const provider = screen.getByText("Garmin");

    expect(
      readiness.compareDocumentPosition(provider) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByText("Activities are synced, but activity summaries need attention."),
    ).toBeTruthy();
  });
});
