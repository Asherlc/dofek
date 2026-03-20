import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { providerActionLabel, ProviderCard } from "./providers";

// Mock modules imported by providers.tsx at the top level
vi.mock("../lib/trpc", () => ({
  trpc: {
    sync: {
      providers: { useQuery: () => ({ data: [], isLoading: false }) },
      providerStats: { useQuery: () => ({ data: [], isLoading: false }) },
      logs: { useQuery: () => ({ data: [], isLoading: false }) },
      triggerSync: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      activeSyncs: { useQuery: () => ({ data: [] }) },
    },
    useUtils: () => ({
      sync: {
        syncStatus: { fetch: vi.fn() },
        providers: { invalidate: vi.fn() },
        providerStats: { invalidate: vi.fn() },
        logs: { invalidate: vi.fn() },
      },
    }),
  },
}));

vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({
    serverUrl: "https://test.example.com",
    sessionToken: "test-token",
  }),
}));

vi.mock("../lib/share-import", () => ({
  importSharedFile: vi.fn(),
}));

function makeProvider(overrides: Partial<{
  id: string;
  label: string;
  enabled: boolean;
  authStatus: "connected" | "not_connected" | "expired";
  lastSyncAt: string | null;
}> = {}) {
  return {
    id: overrides.id ?? "wahoo",
    label: overrides.label ?? "Wahoo",
    enabled: overrides.enabled ?? true,
    authStatus: overrides.authStatus ?? "connected",
    lastSyncAt: overrides.lastSyncAt ?? null,
    ...overrides,
  };
}

const noopFn = () => {};

describe("providerActionLabel", () => {
  it("returns Sync for connected providers", () => {
    expect(providerActionLabel("connected")).toBe("Sync");
  });

  it("returns Connect for disconnected providers", () => {
    expect(providerActionLabel("not_connected")).toBe("Connect");
  });

  it("returns Connect for expired providers", () => {
    expect(providerActionLabel("expired")).toBe("Connect");
  });
});

describe("ProviderCard", () => {
  describe("sync progress", () => {
    it("renders progress bar when syncing with percentage", () => {
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ percentage: 45, message: "Fetching activities..." }}
          onSync={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Fetching activities...")).toBeTruthy();
      // Should NOT show the normal metadata
      expect(screen.queryByText("Connected")).toBeNull();
      expect(screen.queryByText("Never synced")).toBeNull();
    });

    it("renders progress message without percentage", () => {
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ message: "Preparing sync..." }}
          onSync={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Preparing sync...")).toBeTruthy();
    });

    it("renders progress bar without message when only percentage is provided", () => {
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ percentage: 60 }}
          onSync={noopFn}
          onPress={noopFn}
        />,
      );

      // Progress container should be shown (no metadata)
      expect(screen.queryByText("Connected")).toBeNull();
      expect(screen.queryByText("Never synced")).toBeNull();
    });
  });

  describe("normal metadata when not syncing", () => {
    it("renders auth status and last sync time when not syncing", () => {
      render(
        <ProviderCard
          provider={makeProvider({ lastSyncAt: "2026-03-19T12:00:00Z" })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByText(/Last sync:/)).toBeTruthy();
    });

    it("renders 'Never synced' when provider has no lastSyncAt", () => {
      render(
        <ProviderCard
          provider={makeProvider({ lastSyncAt: null })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByText("Never synced")).toBeTruthy();
    });

    it("renders normal metadata when syncing but syncProgress is undefined", () => {
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={undefined}
          onSync={noopFn}
          onPress={noopFn}
        />,
      );

      // When syncing=true but syncProgress is undefined, the condition
      // `syncing && syncProgress` is falsy, so normal metadata is shown
      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByText("Never synced")).toBeTruthy();
    });

    it("renders 'Not connected' status for disconnected providers", () => {
      render(
        <ProviderCard
          provider={makeProvider({ authStatus: "not_connected" })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Not connected")).toBeTruthy();
    });

    it("renders 'Expired' status for expired providers", () => {
      render(
        <ProviderCard
          provider={makeProvider({ authStatus: "expired" })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Expired")).toBeTruthy();
    });
  });

  describe("progress percentage clamping", () => {
    it("clamps percentage to 0 when negative", () => {
      const { container } = render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ percentage: -20 }}
          onSync={noopFn}
          onPress={noopFn}
        />,
      );

      // The progress fill element's width should be clamped to 0%
      const fillElements = container.querySelectorAll("[style]");
      const fillElement = Array.from(fillElements).find(
        (el) => (el as HTMLElement).style.width === "0%",
      );
      expect(fillElement).toBeTruthy();
    });

    it("clamps percentage to 100 when above 100", () => {
      const { container } = render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ percentage: 150 }}
          onSync={noopFn}
          onPress={noopFn}
        />,
      );

      const fillElements = container.querySelectorAll("[style]");
      const fillElement = Array.from(fillElements).find(
        (el) => (el as HTMLElement).style.width === "100%",
      );
      expect(fillElement).toBeTruthy();
    });

    it("passes through valid percentage values", () => {
      const { container } = render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ percentage: 42 }}
          onSync={noopFn}
          onPress={noopFn}
        />,
      );

      const fillElements = container.querySelectorAll("[style]");
      const fillElement = Array.from(fillElements).find(
        (el) => (el as HTMLElement).style.width === "42%",
      );
      expect(fillElement).toBeTruthy();
    });
  });

  it("renders provider label", () => {
    render(
      <ProviderCard
        provider={makeProvider({ label: "Wahoo" })}
        stats={undefined}
        syncing={false}
        syncProgress={undefined}
        onSync={noopFn}
        onPress={noopFn}
      />,
    );

    expect(screen.getByText("Wahoo")).toBeTruthy();
  });
});
