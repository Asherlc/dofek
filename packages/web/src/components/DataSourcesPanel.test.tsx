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
const mockTriggerSyncUseMutation = vi.hoisted(() => vi.fn());
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
const mockActiveSyncsQuery = vi.hoisted(() =>
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
const mockLogsQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<Array<Record<string, unknown>>>>(() => ({
    data: [],
    isLoading: false,
    error: null,
  })),
);
const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    processing: {
      status: { useQuery: mockDataHealthQuery },
      dismiss: { useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }) },
    },
    sync: {
      providers: {
        useQuery: mockProvidersQuery,
      },
      providerStats: { useQuery: mockProviderStatsQuery },
      logs: { useQuery: mockLogsQuery },
      activeSyncs: { useQuery: mockActiveSyncsQuery },
      activeImports: { useQuery: mockActiveImportsQuery },
      triggerSync: { useMutation: mockTriggerSyncUseMutation },
      syncStatus: { fetch: vi.fn() },
    },
    useUtils: () => ({
      invalidate: mockInvalidate,
      sync: {
        providers: { invalidate: vi.fn() },
        syncStatus: { fetch: mockSyncStatusFetch },
      },
      processing: { status: { invalidate: vi.fn() } },
    }),
  },
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mockCaptureException,
}));

vi.mock("./DataSourcesAuthModals.tsx", () => ({
  CredentialAuthModal: ({ providerName }: { providerName: string }) => (
    <div>{providerName} credentials</div>
  ),
  TokenAuthModal: ({
    providerName,
    tokenLabel,
    instructionsUrl,
  }: {
    providerName: string;
    tokenLabel: string;
    instructionsUrl: string;
  }) => (
    <div>
      {providerName} {tokenLabel} {instructionsUrl}
    </div>
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
    recentLogs,
    onSync,
  }: {
    provider: { id: string; name: string };
    state: { status: string; message?: string };
    recentLogs: Array<{ status: string }>;
    onSync: () => void;
  }) => (
    <section data-testid={`provider-card-${provider.id}`}>
      <h4>{provider.name}</h4>
      <p>{state.status}</p>
      {recentLogs[0] ? <p>Latest sync: {recentLogs[0].status}</p> : null}
      {state.message ? <p>{state.message}</p> : null}
      <button type="button" onClick={onSync}>
        Sync
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
import { PageSection } from "./PageSection.tsx";

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
    mockTriggerSyncUseMutation.mockReset();
    mockTriggerSyncUseMutation.mockReturnValue({
      mutateAsync: mockSyncMutateAsync,
      isPending: false,
    });
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
    mockActiveSyncsQuery.mockReset();
    mockActiveSyncsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    mockProviderStatsQuery.mockReset();
    mockProviderStatsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    mockLogsQuery.mockReset();
    mockLogsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    mockCaptureException.mockReset();
  });

  it("uses the Settings section as its single Data Sources heading", () => {
    render(
      <PageSection title="Data Sources" subtitle="Connect and manage health data providers">
        <DataSourcesPanel />
      </PageSection>,
    );

    expect(screen.getAllByRole("heading", { name: "Data Sources" })).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Available data sources" })).toBeTruthy();
  });

  it("groups Garmin connection methods behind a single provider card", () => {
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
          id: "garmin-dump",
          name: "Garmin Dump",
          authorized: false,
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

    expect(screen.getByRole("region", { name: "Garmin connection methods" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Garmin Connect" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Data export" }));
    expect(screen.getByTestId("file-import-garmin-dump")).toBeTruthy();
    expect(screen.queryByTestId("provider-card-garmin")).toBeNull();
  });

  it("reserves stable action and provider regions while inventory loads", () => {
    mockProvidersQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    mockDataHealthQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    const { rerender } = render(<DataSourcesPanel />);
    const actionRegion = screen.getByRole("heading", { name: "Data Sources" }).parentElement;
    const loadingRegion = screen.getByRole("region", { name: "Available data sources" });

    expect(actionRegion?.className).toContain("min-h-20");
    expect(screen.queryByRole("region", { name: "Sync all providers" })).toBeNull();
    expect(loadingRegion.getAttribute("aria-busy")).toBe("true");
    expect(loadingRegion.className).toContain("h-80");
    expect(loadingRegion.className).toContain("sm:h-96");
    expect(loadingRegion.className).toContain("lg:h-[28rem]");
    expect(loadingRegion.className).toContain("overflow-y-auto");
    expect(within(loadingRegion).getByText("Loading processing status…")).toBeTruthy();

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
          id: "whoop",
          name: "WHOOP",
          authorized: true,
          authType: "oauth2",
          importOnly: false,
          pushOnly: false,
          needsReauth: false,
        },
      ],
      isLoading: false,
      error: null,
    });
    rerender(<DataSourcesPanel />);

    const processingRegion = screen.getByRole("region", { name: "Available data sources" });
    expect(screen.getByRole("heading", { name: "Data Sources" }).parentElement).toBe(actionRegion);
    expect(screen.getByRole("region", { name: "Sync all providers" })).toBeTruthy();
    expect(processingRegion).toBe(loadingRegion);
    expect(processingRegion.getAttribute("aria-busy")).toBe("true");
    expect(within(processingRegion).getByText("Loading processing status…")).toBeTruthy();
    expect(screen.getByTestId("provider-card-garmin")).toBeTruthy();

    mockDataHealthQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });
    rerender(<DataSourcesPanel />);

    const resolvedRegion = screen.getByRole("region", { name: "Available data sources" });
    expect(resolvedRegion).toBe(loadingRegion);
    expect(resolvedRegion.getAttribute("aria-busy")).toBe("false");
    expect(screen.getByTestId("provider-card-garmin")).toBeTruthy();
  });

  it("shows active processing progress above provider cards", () => {
    mockDataHealthQuery.mockReturnValue({
      data: {
        overallStatus: "active",
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
            status: "active",
            progressPercentage: 60,
            message: "Activities are updating.",
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
    const readiness = screen.getByText("Recomputing activities", { selector: "span" });
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

  it("opens personal token auth with server-provided instructions", () => {
    mockProvidersQuery.mockReturnValue({
      data: [
        {
          id: "wger",
          name: "Wger",
          authorized: false,
          authType: "token",
          tokenAuth: {
            label: "JWT refresh token",
            instructionsUrl: "https://wger.readthedocs.io/en/latest/api/api.html#jwt-tokens",
          },
          importOnly: false,
          pushOnly: false,
          needsReauth: false,
        },
      ],
      isLoading: false,
      error: null,
    });

    render(<DataSourcesPanel />);
    fireEvent.click(
      within(screen.getByTestId("provider-card-wger")).getByRole("button", { name: "Sync" }),
    );

    expect(
      screen.getByText(
        "Wger JWT refresh token https://wger.readthedocs.io/en/latest/api/api.html#jwt-tokens",
      ),
    ).toBeTruthy();
  });

  it("surfaces and reports missing personal-token metadata", () => {
    mockProvidersQuery.mockReturnValue({
      data: [
        {
          id: "wger",
          name: "Wger",
          authorized: false,
          authType: "token",
          tokenAuth: null,
          importOnly: false,
          pushOnly: false,
          needsReauth: false,
        },
      ],
      isLoading: false,
      error: null,
    });

    render(<DataSourcesPanel />);
    fireEvent.click(
      within(screen.getByTestId("provider-card-wger")).getByRole("button", { name: "Sync" }),
    );

    expect(
      screen.getByText("Wger personal-token authentication is unavailable. Refresh and try again."),
    ).toBeTruthy();
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      operation: "connect-provider",
      providerId: "wger",
    });
    expect(mockCaptureException.mock.calls[0]?.[0]).toMatchObject({
      message: "Wger personal-token authentication is unavailable. Refresh and try again.",
    });
  });

  it("shows provider stats failures without hiding known provider cards", () => {
    const statsError = new Error("Provider statistics are temporarily unavailable");
    mockProviderStatsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: statsError,
    });

    render(<DataSourcesPanel />);

    expect(screen.getByTestId("provider-card-garmin")).toBeTruthy();
    expect(screen.getByText(statsError.message)).toBeTruthy();
  });

  it("keeps cached sync history on cards when its background refresh fails", () => {
    const cachedLog = {
      id: "log-1",
      providerId: "garmin",
      dataType: "activities",
      status: "success",
      recordCount: 12,
      errorMessage: null,
      authFailureReason: null,
      durationMs: 100,
      syncedAt: "2026-07-24T12:00:00.000Z",
    };
    const logsError = new Error("Sync history refresh failed");
    mockLogsQuery.mockReturnValue({
      data: [cachedLog],
      isLoading: false,
      error: logsError,
    });

    render(<DataSourcesPanel />);

    expect(screen.getByTestId("provider-card-garmin")).toBeTruthy();
    expect(screen.getByText(logsError.message)).toBeTruthy();
  });

  it("uses provider-scoped history when the global history request is empty", () => {
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
          recentLogs: [
            {
              id: "garmin-log-1",
              status: "success",
              syncedAt: "2026-07-24T12:00:00.000Z",
              durationMs: 100,
              recordCount: 12,
              dataType: "activities",
              errorMessage: null,
              authFailureReason: null,
            },
          ],
        },
      ],
      isLoading: false,
      error: null,
    });
    mockLogsQuery.mockReturnValue({ data: [], isLoading: false, error: null });

    render(<DataSourcesPanel />);

    expect(
      within(screen.getByTestId("provider-card-garmin")).getByText("Latest sync: success"),
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
    fireEvent.click(screen.getByText("Sync recent data"));

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
    fireEvent.click(screen.getByText("Sync recent data"));

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

  it("reports provider sync startup failures with sanitized context", async () => {
    const error = new Error("Provider queue unavailable");
    mockSyncMutateAsync.mockRejectedValue(error);

    render(<DataSourcesPanel />);
    fireEvent.click(within(screen.getByTestId("provider-card-garmin")).getByText("Sync"));

    await waitFor(() =>
      expect(
        within(screen.getByTestId("provider-card-garmin")).getByText(error.message),
      ).toBeTruthy(),
    );
    expect(mockTriggerSyncUseMutation).toHaveBeenCalledWith({
      meta: { errorReportedLocally: true },
    });
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      operation: "sync.triggerSync",
      providerId: "garmin",
    });
  });

  it("reports bulk sync startup failures once without provider inputs", async () => {
    const error = new Error("Provider queues unavailable");
    mockSyncMutateAsync.mockRejectedValue(error);

    render(<DataSourcesPanel />);
    fireEvent.click(screen.getByText("Sync recent data"));

    await waitFor(() =>
      expect(
        within(screen.getByTestId("provider-card-garmin")).getByText(error.message),
      ).toBeTruthy(),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(error.message);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      operation: "sync.triggerSync",
    });
  });

  it("keeps both bulk actions disabled while provider jobs are still polling", async () => {
    mockSyncMutateAsync.mockResolvedValue({
      jobId: "garmin:job-garmin",
      jobIds: ["garmin:job-garmin"],
      providerJobs: [
        { providerId: "garmin", jobId: "garmin:job-garmin", queueName: "sync-garmin" },
      ],
      providerResults: [
        {
          providerId: "garmin",
          status: "started",
          jobId: "garmin:job-garmin",
          queueName: "sync-garmin",
        },
      ],
    });
    mockPollSyncJob.mockImplementation(() => new Promise(() => {}));

    render(<DataSourcesPanel />);
    fireEvent.click(screen.getByText("Sync recent data"));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Sync all providers for the last 7 days" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Sync full history for all providers" }),
      ).toBeDisabled();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Follow each provider below");
  });

  it("reports polling failures without the job id and skips the global duplicate", async () => {
    const pollError = new Error("Sync status unavailable");
    const jobId = "secret-job-id";
    mockSyncMutateAsync.mockResolvedValue({
      jobId,
      jobIds: [jobId],
      providerJobs: [{ providerId: "garmin", jobId, queueName: "sync-garmin" }],
      providerResults: [
        { providerId: "garmin", status: "started", jobId, queueName: "sync-garmin" },
      ],
    });
    mockPollSyncJob.mockImplementation(async (options) => {
      await options.fetchStatus(jobId);
      options.onError?.(pollError);
    });

    render(<DataSourcesPanel />);
    fireEvent.click(within(screen.getByTestId("provider-card-garmin")).getByText("Sync"));

    await waitFor(() => expect(mockCaptureException).toHaveBeenCalled());
    expect(mockSyncStatusFetch).toHaveBeenCalledWith(
      { jobId },
      {
        staleTime: 0,
        meta: { errorReportedLocally: true },
      },
    );
    expect(mockCaptureException).toHaveBeenCalledWith(pollError, {
      operation: "sync.syncStatus",
      providerId: "garmin",
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(jobId);
  });

  it("shows the active sync server error message", () => {
    mockActiveSyncsQuery.mockReturnValue({
      data: [],
      isLoading: false,
      error: new Error("Active syncs are temporarily unavailable. Please try again."),
    });

    render(<DataSourcesPanel />);

    expect(
      screen.getByText("Active syncs are temporarily unavailable. Please try again."),
    ).toBeTruthy();
  });

  it("cancels active sync polling when the panel unmounts", async () => {
    mockActiveSyncsQuery.mockReturnValue({
      data: [
        {
          jobId: "wahoo:job-active",
          status: "running",
          providers: { wahoo: { status: "running", message: "Syncing activities" } },
        },
      ],
      isLoading: false,
      error: null,
    });
    let pollingSignal: AbortSignal | undefined;
    mockPollSyncJob.mockImplementationOnce((options: { signal?: AbortSignal }) => {
      pollingSignal = options.signal;
      return new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const { unmount } = render(<DataSourcesPanel />);
    await waitFor(() => {
      expect(mockPollSyncJob).toHaveBeenCalledOnce();
    });

    expect(pollingSignal?.aborted).toBe(false);
    unmount();
    expect(pollingSignal?.aborted).toBe(true);
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
