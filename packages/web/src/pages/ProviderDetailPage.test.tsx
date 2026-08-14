// @vitest-environment jsdom
import type { ProviderStats } from "@dofek/providers/provider-stats";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessingStatusSnapshot } from "../components/ProcessingStatusWidget.tsx";

const mockUseParams = vi.fn().mockReturnValue({ id: "strong-csv" });

vi.mock("@tanstack/react-router", () => ({
  useParams: (...args: unknown[]) => mockUseParams(...args),
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode;
    to: string;
    params?: { id: string };
  }) => <a href={params ? to.replace("$id", params.id) : to}>{children}</a>,
}));

vi.mock("../components/AppHeader.tsx", () => ({
  AppHeader: () => <div data-testid="app-header" />,
}));

vi.mock("../components/ProviderLogo.tsx", () => ({
  ProviderLogo: () => <div data-testid="provider-logo" />,
}));

vi.mock("../components/DataSourcesAuthModals.tsx", () => ({
  CredentialAuthModal: () => <div>Credential reconnect form</div>,
  GarminAuthModal: () => <div>Garmin reconnect form</div>,
  TokenAuthModal: () => <div>Token reconnect form</div>,
  WhoopAuthModal: ({ onSuccess }: { onSuccess: () => void }) => (
    <div>
      WHOOP reconnect form
      <button type="button" onClick={onSuccess}>
        Complete WHOOP reconnect
      </button>
    </div>
  ),
}));

const mockFileImportProviderCard = vi.hoisted(() => vi.fn());

vi.mock("../components/FileImportProviderCard.tsx", () => ({
  FileImportProviderCard: ({
    providerId,
    title,
    description,
    showDetailsLink,
    activeImport,
  }: {
    providerId: string;
    title: string;
    description: string;
    showDetailsLink?: boolean;
    activeImport?: Record<string, unknown>;
  }) => {
    mockFileImportProviderCard({
      providerId,
      title,
      description,
      showDetailsLink,
      activeImport,
    });
    return (
      <div data-testid="file-import-provider-card" data-show-details-link={String(showDetailsLink)}>
        <span>{title}</span>
        <span>{description}</span>
        <button type="button">Import file</button>
      </div>
    );
  },
}));

interface MockProvider {
  id: string;
  name: string;
  authorized: boolean;
  authType: string;
  lastSyncedAt: string | null;
  importOnly: boolean;
  needsReauth?: boolean;
  pushOnly?: boolean;
  tokenAuth?: { label: string; instructionsUrl: string } | null;
}

type MockProviderStats = ProviderStats & { providerId: string };

const mockProviders: {
  data: MockProvider[] | undefined;
  error: Error | null;
  isLoading: boolean;
} = {
  data: [],
  error: null,
  isLoading: false,
};

const mockStats: {
  data: MockProviderStats[] | undefined;
  error: Error | null;
  isLoading: boolean;
} = {
  data: [],
  error: null,
  isLoading: false,
};
const mockRecords: {
  data: { rows: Array<Record<string, unknown>>; columns: string[] };
  isLoading: boolean;
  isError: boolean;
  error: null;
} = {
  data: { rows: [], columns: [] },
  isLoading: false,
  isError: false,
  error: null,
};
const mockDetailLogs: {
  data:
    | Array<{
        id: string;
        syncedAt: string;
        dataType: string;
        status: string;
        recordCount: number | null;
        durationMs: number | null;
        errorMessage: string | null;
        authFailureReason: string | null;
      }>
    | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
} = {
  data: [],
  isLoading: false,
  isError: false,
  error: null,
};
const mockAvailableDataTypes = {
  data: ["activities"] as const,
  isLoading: false,
  isError: false,
  error: null,
};
const mockActiveImports: { data: Array<Record<string, unknown>>; isLoading: boolean } = {
  data: [],
  isLoading: false,
};

const mockDataHealth: {
  data: ProcessingStatusSnapshot | null;
  isLoading: boolean;
  error: { message?: string } | null;
} = {
  data: null,
  isLoading: false,
  error: null,
};

const mockSyncMutation = { mutateAsync: vi.fn(), isPending: false };
const mockCaptureException = vi.fn();
const mockDisconnectMutation = { mutateAsync: vi.fn(), isPending: false };
const mockDeleteAllDataMutation = { mutateAsync: vi.fn(), isPending: false };
const mockSettingsGetQuery = vi.fn().mockReturnValue({ data: null, isLoading: false });
const mockSettingsSetMutate = vi.fn();
const mockSettingsGetGetData = vi.fn();
const mockSettingsGetSetData = vi.fn();
const mockSettingsGetInvalidate = vi.fn();
const mockProcessingStatusInvalidate = vi.fn();
const mockProcessingDismissMutation = { mutate: vi.fn(), isPending: false, error: null };
const mockPollSyncJob = vi.fn();
const mockSyncStatusFetch = vi.fn();

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    processing: {
      status: { useQuery: () => mockDataHealth },
      dismiss: { useMutation: () => mockProcessingDismissMutation },
    },
    sync: {
      providers: { useQuery: () => mockProviders },
      providerStats: { useQuery: () => mockStats },
      activeImports: { useQuery: () => mockActiveImports },
      triggerSync: { useMutation: () => mockSyncMutation },
      syncStatus: { fetch: vi.fn() },
    },
    providerDetail: {
      disconnect: { useMutation: () => mockDisconnectMutation },
      deleteAllData: { useMutation: () => mockDeleteAllDataMutation },
      deletionStatus: { useQuery: () => ({ data: undefined, error: null }) },
      logs: { useQuery: () => mockDetailLogs },
      logFilterOptions: { useQuery: () => ({ data: {}, isLoading: false }) },
      availableDataTypes: { useQuery: () => mockAvailableDataTypes },
      records: { useQuery: () => mockRecords },
      recordFilterOptions: { useQuery: () => ({ data: {}, isLoading: false }) },
    },
    settings: {
      get: { useQuery: (...args: unknown[]) => mockSettingsGetQuery(...args) },
      set: { useMutation: () => ({ mutate: mockSettingsSetMutate, isPending: false }) },
    },
    useUtils: () => ({
      processing: {
        status: { invalidate: mockProcessingStatusInvalidate },
      },
      sync: {
        providers: { invalidate: vi.fn() },
        providerStats: { invalidate: vi.fn() },
        syncStatus: { fetch: mockSyncStatusFetch },
      },
      providerDetail: {
        availableDataTypes: { invalidate: vi.fn() },
        logs: { invalidate: vi.fn() },
        records: { invalidate: vi.fn() },
      },
      settings: {
        get: {
          getData: mockSettingsGetGetData,
          setData: mockSettingsGetSetData,
          invalidate: mockSettingsGetInvalidate,
        },
      },
    }),
  },
}));

vi.mock("../lib/poll-sync-job.ts", () => ({
  pollSyncJob: mockPollSyncJob,
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

beforeEach(() => {
  vi.useFakeTimers();
  mockUseParams.mockReturnValue({ id: "strong-csv" });
  mockProviders.data = [];
  mockProviders.error = null;
  mockProviders.isLoading = false;
  mockDataHealth.data = null;
  mockDataHealth.isLoading = false;
  mockDataHealth.error = null;
  mockActiveImports.data = [];
  mockStats.data = [];
  mockStats.error = null;
  mockRecords.data = { rows: [], columns: [] };
  mockRecords.isLoading = false;
  mockRecords.isError = false;
  mockRecords.error = null;
  mockDetailLogs.data = [];
  mockDetailLogs.isLoading = false;
  mockDetailLogs.isError = false;
  mockDetailLogs.error = null;
});

afterEach(() => {
  cleanup();
  act(() => {
    vi.runOnlyPendingTimers();
  });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  mockFileImportProviderCard.mockClear();
});

describe("ProviderDetailPage import-only providers", () => {
  afterEach(() => {
    mockProviders.data = [];
  });

  it("hides sync controls for import-only providers", async () => {
    mockProviders.data = [
      {
        id: "strong-csv",
        name: "Strong",
        authorized: true,
        authType: "none",
        lastSyncedAt: null,
        importOnly: true,
      },
    ];

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByRole("heading", { name: "Strong" })).toBeTruthy();
    expect(screen.queryByText("Sync Controls")).toBeNull();
    expect(screen.queryByText("Sync Last 7 Days")).toBeNull();
    expect(screen.queryByText("Full Sync")).toBeNull();
    expect(screen.queryByText("Sync Range")).toBeNull();
    expect(screen.queryByText("Disconnect")).toBeNull();
  });

  it("shows the provider inventory error on initial failure", async () => {
    mockProviders.data = undefined;
    mockProviders.error = new Error(
      "Analytics data is temporarily unavailable. Please retry in a minute.",
    );

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByTestId("query-state-error")).toBeTruthy();
    expect(
      screen.getByText("Analytics data is temporarily unavailable. Please retry in a minute."),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Strong Csv" })).toBeNull();
  });

  it("shows retained provider details with a refresh warning after a background failure", async () => {
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];
    mockProviders.error = new Error(
      "Analytics data is temporarily unavailable. Please retry in a minute.",
    );

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByRole("heading", { name: "Wahoo" })).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Could not refresh provider details.")).toBeTruthy();
    expect(
      screen.getByText("Analytics data is temporarily unavailable. Please retry in a minute."),
    ).toBeTruthy();
  });

  it("renders a not-found state without exposing generic sync controls", async () => {
    mockUseParams.mockReturnValue({ id: "does-not-exist" });
    mockProviders.data = [];

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByText("Provider not found")).toBeTruthy();
    expect(
      screen.getByText("This provider is unavailable. Return to Data Sources to choose another."),
    ).toBeTruthy();
    expect(screen.queryByText("Sync Controls")).toBeNull();
    expect(screen.queryByText("Sync Last 7 Days")).toBeNull();
  });

  it("shows provider statistics failures while retaining known provider details", async () => {
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];
    mockStats.data = undefined;
    mockStats.error = new Error("Provider statistics are temporarily unavailable");

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByRole("heading", { name: "Wahoo" })).toBeTruthy();
    expect(screen.getByText("Provider statistics are temporarily unavailable")).toBeTruthy();
    expect(screen.getByText("Sync Controls")).toBeTruthy();
  });

  it("keeps cached sync history visible when its background refresh fails", async () => {
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];
    mockDetailLogs.data = [
      {
        id: "log-1",
        syncedAt: "2026-07-24T12:00:00.000Z",
        dataType: "activities",
        status: "success",
        recordCount: 12,
        durationMs: 100,
        errorMessage: null,
        authFailureReason: null,
      },
    ];
    mockDetailLogs.isError = true;
    mockDetailLogs.error = new Error("Sync history refresh failed");

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByText("Sync history refresh failed")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Activities data synced" })).toBeTruthy();
    expect(screen.getByText("12 records")).toBeTruthy();
  });

  it("explains an expired provider authorization before exposing diagnostics", async () => {
    mockUseParams.mockReturnValue({ id: "whoop" });
    mockProviders.data = [
      {
        id: "whoop",
        name: "WHOOP",
        authorized: false,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
        needsReauth: true,
      },
    ];
    mockDetailLogs.data = [
      {
        id: "raw-log-123",
        syncedAt: "2026-07-24T12:00:00.000Z",
        dataType: "strength",
        status: "error",
        recordCount: null,
        durationMs: 1250,
        errorMessage: "OAuth token refresh returned invalid_grant",
        authFailureReason: "refresh_token_revoked",
      },
    ];

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByRole("heading", { name: "Authorization expired" })).toBeTruthy();
    expect(screen.getByText("Reconnect WHOOP to resume Strength data.")).toBeTruthy();
    expect(screen.getByText("Diagnostics").closest("details")?.hasAttribute("open")).toBe(false);
  });

  it("shows 'Import only' instead of 'Connected' for import-only providers", async () => {
    mockProviders.data = [
      {
        id: "strong-csv",
        name: "Strong",
        authorized: true,
        authType: "none",
        lastSyncedAt: null,
        importOnly: true,
      },
    ];

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByText("Import only")).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("shows the upload card for Garmin dump on the provider detail page", async () => {
    mockUseParams.mockReturnValue({ id: "garmin-dump" });
    mockProviders.data = [
      {
        id: "garmin-dump",
        name: "Garmin Dump",
        authorized: true,
        authType: "file-import",
        lastSyncedAt: null,
        importOnly: true,
      },
    ];

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByRole("heading", { name: "Garmin Dump" })).toBeTruthy();
    expect(screen.getByText("Import")).toBeTruthy();
    expect(
      screen.getByTestId("file-import-provider-card").getAttribute("data-show-details-link"),
    ).toBe("false");
    expect(screen.getByText(".zip account export from Garmin")).toBeTruthy();
    expect(screen.getByText("Import file")).toBeTruthy();
    expect(screen.queryByText("Sync Controls")).toBeNull();
  });

  it("shows the shared upload card for Apple Health on the provider detail page", async () => {
    mockUseParams.mockReturnValue({ id: "apple_health" });
    mockProviders.data = [];

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByRole("heading", { name: "Apple Health" })).toBeTruthy();
    expect(screen.getByText("Import")).toBeTruthy();
    expect(screen.getByText(".zip or .xml from Health app export")).toBeTruthy();
    expect(screen.getByText("Import file")).toBeTruthy();
    expect(screen.queryByText("Sync Controls")).toBeNull();
    expect(mockFileImportProviderCard).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "apple_health",
        title: "Apple Health",
        showDetailsLink: false,
      }),
    );
  });

  it("passes the active import to the provider details card after refresh", async () => {
    mockUseParams.mockReturnValue({ id: "strong-csv" });
    const activeImport = {
      jobId: "job-strong",
      providerId: "strong-csv",
      status: "running",
      percentage: 37,
      message: "Importing workouts",
    };
    mockActiveImports.data = [activeImport];

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(mockFileImportProviderCard).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "strong-csv", activeImport }),
    );
  });

  it("shows sync controls for non-import-only providers", async () => {
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByText("Sync Controls")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByText("Import only")).toBeNull();
  });

  it("gives WHOOP one exact range and one sync action", async () => {
    mockUseParams.mockReturnValue({ id: "whoop" });
    mockProviders.data = [
      {
        id: "whoop",
        name: "WHOOP",
        authorized: true,
        authType: "custom:whoop",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];
    mockSyncMutation.mutateAsync.mockResolvedValue({
      providerResults: [
        {
          providerId: "whoop",
          status: "skippedCooldown",
          message: "WHOOP sync is already current",
        },
      ],
    });

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByLabelText("From")).toBeTruthy();
    expect(screen.getByLabelText("To")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Sync" })).toHaveLength(1);
    expect(screen.queryByText("Sync Last 7 Days")).toBeNull();
    expect(screen.queryByText("Full Sync")).toBeNull();
    expect(screen.queryByText("Sync Range")).toBeNull();
    expect(screen.queryByText("Sync Dates")).toBeNull();

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-06-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-06-15" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    });

    expect(mockSyncMutation.mutateAsync).toHaveBeenCalledWith({
      providerId: "whoop",
      sinceDate: "2026-06-01",
      untilDate: "2026-06-15",
    });
  });

  it("does not start a WHOOP sync when its selected range is inverted", async () => {
    mockUseParams.mockReturnValue({ id: "whoop" });
    mockProviders.data = [
      {
        id: "whoop",
        name: "WHOOP",
        authorized: true,
        authType: "custom:whoop",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-06-18" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-06-17" } });
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));

    expect(screen.getByText('"From" date must be on or before "To" date')).toBeTruthy();
    expect(mockSyncMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("shows provider processing progress while read models update", async () => {
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];
    mockDataHealth.data = {
      overallStatus: "active",
      generatedAt: "2026-06-30T12:00:00Z",
      scope: { providerId: "wahoo", datasets: ["activity"] },
      operations: [],
      datasets: [
        {
          key: "activity",
          label: "Activities",
          status: "active",
          currentStage: "cdc",
          progressPercentage: null,
          lastAdvancedAt: "2026-06-29T12:00:00Z",
          lastReadyAt: null,
          lastFailedAt: null,
        },
      ],
    };

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByText("Wahoo data status")).toBeTruthy();
    expect(screen.getByText("Syncing Wahoo")).toBeTruthy();
  });

  it("separates connection from expired authorization and promotes reconnect", async () => {
    mockUseParams.mockReturnValue({ id: "whoop" });
    mockProviders.data = [
      {
        id: "whoop",
        name: "WHOOP",
        authorized: true,
        authType: "custom:whoop",
        lastSyncedAt: "2026-06-29T12:00:00Z",
        importOnly: false,
        needsReauth: true,
      },
    ];

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByText("Connection")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Authorization")).toBeTruthy();
    expect(screen.getByText("Reconnect required")).toBeTruthy();
    expect(screen.queryByText("Sync Controls")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reconnect WHOOP" }));
    expect(screen.getByText("WHOOP reconnect form")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Complete WHOOP reconnect" }));
    expect(mockProcessingStatusInvalidate).toHaveBeenCalledWith({ providerId: "whoop" });
  });

  it("shows token reconnect errors when expired credentials were removed", async () => {
    mockUseParams.mockReturnValue({ id: "ultrahuman" });
    mockProviders.data = [
      {
        id: "ultrahuman",
        name: "Ultrahuman",
        authorized: false,
        authType: "token",
        lastSyncedAt: null,
        importOnly: false,
        needsReauth: true,
        tokenAuth: null,
      },
    ];

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect Ultrahuman" }));

    expect(
      screen.getByText(
        "Ultrahuman personal-token authentication is unavailable. Refresh and try again.",
      ),
    ).toBeTruthy();
  });

  it("keeps ready provider dataset freshness visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T14:00:00Z"));
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: "2026-06-30T12:00:00Z",
        importOnly: false,
      },
    ];
    mockDataHealth.data = {
      overallStatus: "ready",
      generatedAt: "2026-06-30T14:00:00Z",
      scope: { providerId: "wahoo", datasets: ["activity"] },
      operations: [],
      datasets: [
        {
          key: "activity",
          label: "Activities",
          status: "ready",
          currentStage: null,
          progressPercentage: 100,
          lastAdvancedAt: "2026-06-30T12:00:00Z",
          lastReadyAt: "2026-06-30T12:00:00Z",
          lastFailedAt: null,
        },
      ],
    };

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByText("Last ready: 2h ago")).toBeTruthy();
  });

  it("shows single-provider cooldown outcome without polling a fake job", async () => {
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];
    mockSyncMutation.mutateAsync.mockResolvedValue({
      jobId: "job-skipped",
      jobIds: [],
      providerJobs: [],
      providerResults: [
        {
          providerId: "wahoo",
          status: "skippedCooldown",
          message: "Provider sync skipped: rate-limit cooldown active",
        },
      ],
    });
    const { pollSyncJob } = await import("../lib/poll-sync-job.ts");

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    await act(async () => {
      fireEvent.click(screen.getByText("Sync Last 7 Days"));
    });

    expect(screen.getByText("Provider sync skipped: rate-limit cooldown active")).toBeTruthy();
    expect(pollSyncJob).not.toHaveBeenCalled();
  });

  it("invalidates processing status when a manual sync completes", async () => {
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];
    mockSyncMutation.mutateAsync.mockResolvedValue({
      jobId: "job-1",
      jobIds: ["job-1"],
      providerJobs: [{ providerId: "wahoo", jobId: "job-1", queueName: "sync-wahoo" }],
      providerResults: [{ providerId: "wahoo", status: "started", jobId: "job-1" }],
    });
    mockPollSyncJob.mockImplementationOnce(async ({ onComplete }: { onComplete: () => void }) =>
      onComplete(),
    );

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    await act(async () => {
      fireEvent.click(screen.getByText("Sync Last 7 Days"));
    });

    expect(mockProcessingStatusInvalidate).toHaveBeenCalledOnce();
  });

  it("cancels sync polling when the provider page unmounts", async () => {
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];
    mockSyncMutation.mutateAsync.mockResolvedValue({
      jobId: "job-1",
      jobIds: ["job-1"],
      providerJobs: [{ providerId: "wahoo", jobId: "job-1", queueName: "sync-wahoo" }],
      providerResults: [{ providerId: "wahoo", status: "started", jobId: "job-1" }],
    });
    let pollingSignal: AbortSignal | undefined;
    mockPollSyncJob.mockImplementationOnce((options: { signal?: AbortSignal }) => {
      pollingSignal = options.signal;
      return new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    const { unmount } = render(<ProviderDetailPage />);

    act(() => {
      fireEvent.click(screen.getByText("Sync Last 7 Days"));
    });
    await act(async () => Promise.resolve());

    expect(pollingSignal?.aborted).toBe(false);
    unmount();
    expect(pollingSignal?.aborted).toBe(true);
  });

  it("reports unexpected provider sync failures", async () => {
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];
    const syncError = new Error("Queue unavailable");
    mockSyncMutation.mutateAsync.mockRejectedValue(syncError);

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    await act(async () => {
      fireEvent.click(screen.getByText("Sync Last 7 Days"));
    });

    expect(mockCaptureException).toHaveBeenCalledWith(syncError, {
      operation: "sync.triggerSync",
      providerId: "wahoo",
    });
    expect(screen.getByText("Queue unavailable")).toBeTruthy();
  });

  it("reports provider polling failures without the job id", async () => {
    const jobId = "secret-provider-job-id";
    const pollError = new Error("Sync status unavailable");
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];
    mockSyncMutation.mutateAsync.mockResolvedValue({
      jobId,
      jobIds: [jobId],
      providerJobs: [{ providerId: "wahoo", jobId, queueName: "sync-wahoo" }],
      providerResults: [{ providerId: "wahoo", status: "started", jobId }],
    });
    mockPollSyncJob.mockImplementationOnce(
      async ({
        fetchStatus,
        onError,
      }: {
        fetchStatus: (id: string) => Promise<unknown>;
        onError: (error: unknown) => void;
      }) => {
        await fetchStatus(jobId);
        onError(pollError);
      },
    );

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    await act(async () => {
      fireEvent.click(screen.getByText("Sync Last 7 Days"));
    });

    expect(mockSyncStatusFetch).toHaveBeenCalledWith(
      { jobId },
      { staleTime: 0, meta: { errorReportedLocally: true } },
    );
    expect(mockCaptureException).toHaveBeenCalledWith(pollError, {
      operation: "sync.syncStatus",
      providerId: "wahoo",
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(jobId);
  });

  it("does not trigger sync for an inverted date range", async () => {
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];
    mockSyncMutation.mutateAsync.mockResolvedValue({ jobId: "job-1" });

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-06-18" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-06-17" } });
    fireEvent.click(screen.getByText("Sync Dates"));

    expect(screen.getByText('"From" date must be on or before "To" date')).toBeTruthy();
    expect(mockSyncMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("does not render sync controls for providers that are not connected", async () => {
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: false,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getAllByText("Not connected")).toHaveLength(2);
    expect(screen.queryByText("Sync Controls")).toBeNull();
    expect(screen.queryByText("Sync Last 7 Days")).toBeNull();
    expect(screen.queryByText("Full Sync")).toBeNull();
    expect(screen.queryByText("Sync Range")).toBeNull();
    expect(screen.queryByText("Sync Dates")).toBeNull();
    expect(screen.queryByText("Disconnect")).toBeNull();
  });
});

describe("ProviderDetailPage delete all data", () => {
  beforeEach(() => {
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];
  });

  it("requires typing DELETE before deleting provider records", async () => {
    mockDeleteAllDataMutation.mutateAsync.mockResolvedValue({ success: true });
    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getAllByRole("heading", { name: "Danger Zone" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Disconnect Wahoo" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete all data" }));
    const confirmButton = screen.getByRole("button", { name: "Permanently delete data" });
    expect(confirmButton).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText('Type "DELETE" to confirm'), {
      target: { value: "DELETE" },
    });
    await act(async () => {
      fireEvent.click(confirmButton);
    });

    expect(mockDeleteAllDataMutation.mutateAsync).toHaveBeenCalledWith({
      providerId: "wahoo",
      confirmation: "DELETE",
    });
  });
});

describe("ProviderDetailPage activity records", () => {
  it("shows canonical activity records while aggregate provider stats are catching up", async () => {
    mockUseParams.mockReturnValue({ id: "kaya-export" });
    mockProviders.data = [
      {
        id: "kaya-export",
        name: "Kaya",
        authorized: true,
        authType: "file-import",
        lastSyncedAt: null,
        importOnly: true,
      },
    ];
    mockStats.data = [];
    mockRecords.data = {
      rows: [{ id: "activity-123", name: "Kaya climbing" }],
      columns: ["id", "name"],
    };

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByText("Kaya climbing")).toBeTruthy();
    expect(screen.queryByText("No records yet for this provider.")).toBeNull();
  });

  it("links from an activity record modal to the activity detail page", async () => {
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];
    mockStats.data = [
      {
        providerId: "wahoo",
        totalRecords: 1,
        activities: 1,
        metricStream: 0,
        dailyMetrics: 0,
        sleepSessions: 0,
        bodyMeasurements: 0,
        foodEntries: 0,
        nutritionDaily: 0,
        healthEvents: 0,
        labPanels: 0,
        labResults: 0,
        journalEntries: 0,
      },
    ];
    mockRecords.data = {
      rows: [{ id: "activity-123", name: "Morning Ride" }],
      columns: ["id", "name"],
    };

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    fireEvent.click(screen.getByText("Morning Ride"));

    expect(screen.getByRole("link", { name: "Open activity" }).getAttribute("href")).toBe(
      "/activity/activity-123",
    );
  });
});

describe("WhoopWearLocationPicker", () => {
  beforeEach(() => {
    mockUseParams.mockReturnValue({ id: "whoop" });
    mockProviders.data = [
      {
        id: "whoop",
        name: "WHOOP",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: "2026-03-19T12:00:00Z",
        importOnly: false,
      },
    ];
    mockSettingsGetQuery.mockReturnValue({ data: null, isLoading: false });
    mockSettingsSetMutate.mockReset();
    mockSettingsGetGetData.mockReset();
    mockSettingsGetSetData.mockReset();
    mockSettingsGetInvalidate.mockReset();
  });

  afterEach(() => {
    mockProviders.data = [];
    mockUseParams.mockReturnValue({ id: "strong-csv" });
  });

  it("renders wear location picker when providerId is whoop", async () => {
    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByText("Wear Location")).toBeTruthy();
    expect(
      screen.getByText("Where do you wear your WHOOP? This helps us interpret your sensor data."),
    ).toBeTruthy();
  });

  it("renders all five wear location options", async () => {
    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByText("Wrist")).toBeTruthy();
    expect(screen.getByText("Bicep / Upper Arm")).toBeTruthy();
    expect(screen.getByText("Chest / Torso")).toBeTruthy();
    expect(screen.getByText("Waist / Waistband")).toBeTruthy();
    expect(screen.getByText("Lower Leg / Calf")).toBeTruthy();
  });

  it("does not render wear location picker for non-whoop providers", async () => {
    mockUseParams.mockReturnValue({ id: "wahoo" });
    mockProviders.data = [
      {
        id: "wahoo",
        name: "Wahoo",
        authorized: true,
        authType: "oauth",
        lastSyncedAt: null,
        importOnly: false,
      },
    ];

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.queryByText("Wear Location")).toBeNull();
  });

  it("defaults to wrist when no setting is stored", async () => {
    mockSettingsGetQuery.mockReturnValue({ data: null, isLoading: false });

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    const wristButton = screen.getByText("Wrist").closest("button");
    expect(wristButton).toBeTruthy();
    expect(wristButton?.className).toContain("border-emerald-500");
  });

  it("highlights the currently selected location", async () => {
    mockSettingsGetQuery.mockReturnValue({
      data: { key: "whoop.wearLocation", value: "bicep" },
      isLoading: false,
    });

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    const bicepButton = screen.getByText("Bicep / Upper Arm").closest("button");
    expect(bicepButton?.className).toContain("border-emerald-500");

    const wristButton = screen.getByText("Wrist").closest("button");
    expect(wristButton?.className).not.toContain("border-emerald-500");
  });

  it("calls the settings mutation when a location is clicked", async () => {
    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    fireEvent.click(screen.getByText("Bicep / Upper Arm"));

    expect(mockSettingsSetMutate).toHaveBeenCalledWith(
      { key: "whoop.wearLocation", value: "bicep" },
      expect.objectContaining({
        onError: expect.any(Function),
        onSettled: expect.any(Function),
      }),
    );
  });

  it("optimistically updates the cache when a location is clicked", async () => {
    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    fireEvent.click(screen.getByText("Chest / Torso"));

    expect(mockSettingsGetSetData).toHaveBeenCalledWith(
      { key: "whoop.wearLocation" },
      { key: "whoop.wearLocation", value: "chest" },
    );
  });

  it("restores the exact cached location and displays the server error when a write fails", async () => {
    const previousSetting = { key: "whoop.wearLocation", value: "bicep" };
    mockSettingsGetQuery.mockReturnValue({
      data: previousSetting,
      error: null,
      isLoading: false,
    });
    mockSettingsGetGetData.mockReturnValue(previousSetting);
    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    fireEvent.click(screen.getByText("Chest / Torso"));
    const options = mockSettingsSetMutate.mock.calls[0]?.[1];
    const writeError = new Error("Wear location was not saved.");
    act(() => options.onError(writeError));
    act(() => options.onSettled());

    expect(mockSettingsGetSetData).toHaveBeenLastCalledWith(
      { key: "whoop.wearLocation" },
      previousSetting,
    );
    expect(mockSettingsGetInvalidate).toHaveBeenCalledWith({ key: "whoop.wearLocation" });
    expect(screen.getByRole("alert").textContent).toBe(writeError.message);
    expect(mockCaptureException).toHaveBeenCalledWith(writeError, {
      context: "whoop-wear-location-write",
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("keeps cached location visible and displays an exact background read error", async () => {
    const readError = new Error("Wear location could not be loaded.");
    mockSettingsGetQuery.mockReturnValue({
      data: { key: "whoop.wearLocation", value: "bicep" },
      error: readError,
      isLoading: false,
    });

    const { ProviderDetailPage } = await import("./ProviderDetailPage");
    render(<ProviderDetailPage />);

    expect(screen.getByText("Bicep / Upper Arm").closest("button")?.className).toContain(
      "border-emerald-500",
    );
    expect(screen.getByRole("alert").textContent).toBe(readError.message);
    expect(mockCaptureException).toHaveBeenCalledWith(readError, {
      context: "whoop-wear-location-read",
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
