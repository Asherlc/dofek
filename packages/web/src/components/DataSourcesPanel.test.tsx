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
const mockFileImportProviderCard = vi.hoisted(() => vi.fn());
const mockActiveImportsQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<Array<Record<string, unknown>>>>(() => ({
    data: [],
    isLoading: false,
    error: null,
  })),
);
const mockProviderStatsQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<Array<Record<string, unknown>>>>(() => ({
    data: [],
    isLoading: false,
    error: null,
  })),
);

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    processing: {
      status: { useQuery: mockDataHealthQuery },
    },
    sync: {
      providers: {
        useQuery: mockProvidersQuery,
      },
      providerStats: { useQuery: mockProviderStatsQuery },
      logs: { useQuery: () => ({ data: [], isLoading: false }) },
      activeSyncs: { useQuery: () => ({ data: [], isLoading: false }) },
      activeImports: { useQuery: mockActiveImportsQuery },
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

vi.mock("./FileImportProviderCard.tsx", () => ({
  FileImportProviderCard: (props: {
    providerId?: string;
    title: string;
    description: string;
    accept: string;
    importType: string;
    stats?: Record<string, unknown>;
    activeImport?: Record<string, unknown>;
  }) => {
    mockFileImportProviderCard(props);
    return (
      <section data-testid={`file-import-${props.providerId ?? props.title}`}>
        <h4>{props.title}</h4>
        <p>{props.description}</p>
        <button type="button">Import file</button>
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
    mockFileImportProviderCard.mockClear();
    mockActiveImportsQuery.mockReset();
    mockActiveImportsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    mockProviderStatsQuery.mockReset();
    mockProviderStatsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
  });

  it("shows server data readiness messages above provider cards", () => {
    mockDataHealthQuery.mockReturnValue({
      data: {
        overallStatus: "blocked",
        generatedAt: "2026-06-30T08:00:00.000Z",
        scope: { providerId: null, datasets: ["providers"] },
        operations: [],
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

    expect(mockDataHealthQuery).toHaveBeenCalledWith(
      { datasets: ["providers"] },
      expect.any(Object),
    );
    const readiness = screen.getByText("Your data update didn’t finish");
    const provider = screen.getByText("Garmin");

    expect(
      readiness.compareDocumentPosition(provider) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps cached providers visible when a background refresh fails", () => {
    const refreshError = new Error(
      "Analytics data is temporarily unavailable. Please retry in a minute.",
    );
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
      ],
      isLoading: false,
      error: refreshError,
    });

    render(<DataSourcesPanel />);

    expect(screen.getByTestId("provider-card-garmin")).toBeTruthy();
    expect(screen.getByText(refreshError.message)).toBeTruthy();
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
    expect(mockFileImportProviderCard).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "kaya-export",
        title: "Kaya",
        description: ".csv export from Kaya",
        accept: ".csv",
        importType: "kaya-export",
      }),
    );
  });

  it("passes provider summaries to file import cards", () => {
    const appleHealthStats = {
      providerId: "apple_health",
      activities: 0,
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
    };
    const kayaStats = {
      providerId: "kaya-export",
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
    };
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
    mockProviderStatsQuery.mockReturnValue({
      data: [appleHealthStats, kayaStats],
      isLoading: false,
      error: null,
    });

    render(<DataSourcesPanel />);

    expect(mockFileImportProviderCard).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "kaya-export",
        stats: kayaStats,
      }),
    );
    expect(mockFileImportProviderCard).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "apple_health",
        stats: appleHealthStats,
      }),
    );
  });

  it("passes active imports to the matching settings card after refresh", () => {
    const activeImport = {
      jobId: "job-kaya",
      providerId: "kaya-export",
      status: "running",
      percentage: 42,
      message: "Importing climbs",
    };
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
    mockActiveImportsQuery.mockReturnValue({
      data: [activeImport],
      isLoading: false,
      error: null,
    });

    render(<DataSourcesPanel />);

    expect(mockFileImportProviderCard).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "kaya-export", activeImport }),
    );
  });

  it("renders Apple Health through the shared file import provider card", () => {
    render(<DataSourcesPanel />);

    expect(screen.getByTestId("file-import-apple_health")).toBeTruthy();
    expect(screen.getByText("Import file")).toBeTruthy();
    expect(mockFileImportProviderCard).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "apple_health",
        title: "Apple Health",
        description: ".zip or .xml from Health app export",
        importType: "apple-health",
      }),
    );
  });
});
