// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const mockProvidersQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<Array<Record<string, unknown>>>>(() => ({
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
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        importOnly: false,
        pushOnly: false,
        needsReauth: false,
      },
    ],
    isLoading: false,
    error: null,
  })),
);

const mockSyncMutateAsync = vi.hoisted(() => vi.fn());
const mockPollSyncJob = vi.hoisted(() => vi.fn());
const mockInvalidate = vi.hoisted(() => vi.fn());
const mockSyncStatusFetch = vi.hoisted(() => vi.fn());
const mockFileImportZone = vi.hoisted(() => vi.fn());

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    sync: {
      providers: {
        useQuery: mockProvidersQuery,
      },
      providerStats: { useQuery: () => ({ data: [], isLoading: false }) },
      logs: { useQuery: () => ({ data: [], isLoading: false }) },
      activeSyncs: { useQuery: () => ({ data: [], isLoading: false }) },
      dataHealth: { useQuery: mockDataHealthQuery },
      triggerSync: { useMutation: () => ({ mutateAsync: mockSyncMutateAsync, isPending: false }) },
      syncStatus: { fetch: vi.fn() },
    },
    useUtils: () => ({
      invalidate: mockInvalidate,
      sync: {
        providers: { invalidate: vi.fn() },
        syncStatus: { fetch: mockSyncStatusFetch },
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
  FileImportZone: (props: {
    providerId?: string;
    title: string;
    description: string;
    accept: string;
    uploadUrl: string;
    statusUrl: string;
  }) => {
    mockFileImportZone(props);
    return (
      <section data-testid={`file-import-${props.providerId ?? props.title}`}>
        <h4>{props.title}</h4>
        <p>{props.description}</p>
      </section>
    );
  },
}));

vi.mock("./SyncProviderCard.tsx", () => ({
  SyncProviderCard: ({
    provider,
    state,
    onSync,
    onFullSync,
  }: {
    provider: { id: string; name: string };
    state: { status: string; message?: string };
    onSync: () => void;
    onFullSync: () => void;
  }) => (
    <section data-testid={`provider-card-${provider.id}`}>
      <h4>{provider.name}</h4>
      <p>{state.status}</p>
      {state.message ? <p>{state.message}</p> : null}
      <button type="button" onClick={onSync}>
        Sync
      </button>
      <button type="button" onClick={onFullSync}>
        Full sync
      </button>
    </section>
  ),
}));

vi.mock("../lib/poll-sync-job.ts", () => ({
  pollSyncJob: mockPollSyncJob,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/providers/garmin">{children}</a>,
}));

import { DataSourcesPanel } from "./DataSourcesPanel.tsx";

afterEach(cleanup);

describe("DataSourcesPanel", () => {
  beforeEach(() => {
    mockProvidersQuery.mockReturnValue({
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
        {
          id: "wahoo",
          name: "Wahoo",
          authorized: true,
          authType: "oauth",
          importOnly: false,
          pushOnly: false,
          needsReauth: false,
        },
      ],
      isLoading: false,
      error: null,
    });
    mockDataHealthQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
    mockSyncMutateAsync.mockReset();
    mockSyncMutateAsync.mockResolvedValue({
      jobId: undefined,
      jobIds: [],
      providerJobs: [],
      providerResults: [],
    });
    mockPollSyncJob.mockReset();
    mockPollSyncJob.mockResolvedValue(undefined);
    mockInvalidate.mockReset();
    mockSyncStatusFetch.mockReset();
    mockFileImportZone.mockClear();
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

  it("shows sync-all skipped and failed provider outcomes only on matching cards", async () => {
    mockSyncMutateAsync.mockResolvedValue({
      jobId: "garmin:job-garmin",
      jobIds: ["garmin:job-garmin"],
      providerJobs: [
        { providerId: "garmin", jobId: "garmin:job-garmin", queueName: "sync-garmin" },
      ],
      providerResults: [
        {
          providerId: "garmin",
          status: "skippedCooldown",
          message: "Provider sync skipped: rate-limit cooldown active",
        },
        {
          providerId: "wahoo",
          status: "failed",
          message: "provider queue unavailable",
        },
      ],
    });

    render(<DataSourcesPanel />);
    fireEvent.click(screen.getByText("Sync All"));

    const garminCard = within(screen.getByTestId("provider-card-garmin"));
    const wahooCard = within(screen.getByTestId("provider-card-wahoo"));

    await waitFor(() => {
      expect(
        garminCard.getByText("Provider sync skipped: rate-limit cooldown active"),
      ).toBeTruthy();
      expect(wahooCard.getByText("provider queue unavailable")).toBeTruthy();
    });
    expect(garminCard.queryByText("provider queue unavailable")).toBeNull();
    expect(wahooCard.queryByText("Provider sync skipped: rate-limit cooldown active")).toBeNull();
    expect(mockPollSyncJob).not.toHaveBeenCalled();
  });

  it("polls provider-scoped job ids for sync-all started and already queued outcomes", async () => {
    mockSyncMutateAsync.mockResolvedValue({
      jobId: "garmin:job-garmin",
      jobIds: ["garmin:job-garmin", "wahoo:job-wahoo"],
      providerJobs: [
        { providerId: "garmin", jobId: "garmin:job-garmin", queueName: "sync-garmin" },
        { providerId: "wahoo", jobId: "wahoo:job-wahoo", queueName: "sync-wahoo" },
      ],
      providerResults: [
        {
          providerId: "garmin",
          status: "started",
          jobId: "garmin:job-garmin",
          queueName: "sync-garmin",
        },
        {
          providerId: "wahoo",
          status: "alreadyQueued",
          jobId: "wahoo:job-wahoo",
          queueName: "sync-wahoo",
        },
      ],
    });

    render(<DataSourcesPanel />);
    fireEvent.click(screen.getByText("Sync All"));

    await waitFor(() => {
      expect(mockPollSyncJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "garmin:job-garmin",
          providerIds: ["garmin"],
        }),
      );
      expect(mockPollSyncJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "wahoo:job-wahoo",
          providerIds: ["wahoo"],
        }),
      );
    });
    expect(mockPollSyncJob).toHaveBeenCalledTimes(2);
  });

  it("shows Kaya as a file import source with export upload routes", () => {
    mockProvidersQuery.mockReturnValue({
      data: [
        {
          id: "kaya-export",
          name: "Kaya",
          authorized: true,
          authType: "file-import",
          importOnly: true,
          pushOnly: false,
          needsReauth: false,
        },
      ],
      isLoading: false,
      error: null,
    });

    render(<DataSourcesPanel />);

    expect(screen.getByTestId("file-import-kaya-export")).toBeTruthy();
    expect(screen.getByText("Kaya")).toBeTruthy();
    expect(screen.getByText(".csv export from Kaya")).toBeTruthy();
    expect(mockFileImportZone).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "kaya-export",
        title: "Kaya",
        description: ".csv export from Kaya",
        accept: ".csv",
        uploadUrl: "/api/upload/kaya-export",
        statusUrl: "/api/upload/kaya-export/status",
      }),
    );
  });
});
