// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCellValue, formatColumnName, RecordDetailModal } from "./ProviderDetailPage";

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ id: "strong-csv" }),
  Link: ({ children, ...props }: { children: ReactNode; to: string }) => (
    <a href={props.to}>{children}</a>
  ),
}));

vi.mock("../components/AppHeader.tsx", () => ({
  AppHeader: () => <div data-testid="app-header" />,
}));

vi.mock("../components/ProviderLogo.tsx", () => ({
  ProviderLogo: () => <div data-testid="provider-logo" />,
}));

interface MockProvider {
  id: string;
  name: string;
  authorized: boolean;
  authType: string;
  lastSyncedAt: string | null;
  importOnly: boolean;
}

const mockProviders: { data: MockProvider[]; isLoading: boolean } = {
  data: [],
  isLoading: false,
};

const mockStats = { data: [], isLoading: false };

const mockSyncMutation = { mutateAsync: vi.fn(), isPending: false };
const mockDisconnectMutation = { mutateAsync: vi.fn(), isPending: false };

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    sync: {
      providers: { useQuery: () => mockProviders },
      providerStats: { useQuery: () => mockStats },
      triggerSync: { useMutation: () => mockSyncMutation },
      syncStatus: { fetch: vi.fn() },
    },
    providerDetail: {
      disconnect: { useMutation: () => mockDisconnectMutation },
      logs: { useQuery: () => ({ data: [], isLoading: false }) },
      records: { useQuery: () => ({ data: { rows: [] }, isLoading: false }) },
    },
    useUtils: () => ({
      sync: {
        providers: { invalidate: vi.fn() },
        providerStats: { invalidate: vi.fn() },
        syncStatus: { fetch: vi.fn() },
      },
      providerDetail: {
        logs: { invalidate: vi.fn() },
        records: { invalidate: vi.fn() },
      },
    }),
  },
}));

vi.mock("../lib/poll-sync-job.ts", () => ({
  pollSyncJob: vi.fn(),
}));

afterEach(cleanup);

function queryButton(container: HTMLElement, ariaLabel: string): Element {
  const el = container.querySelector(`button[aria-label="${ariaLabel}"]`);
  if (el === null) throw new Error(`Expected a <button> with aria-label="${ariaLabel}"`);
  return el;
}

describe("formatColumnName", () => {
  it("converts snake_case to Title Case", () => {
    expect(formatColumnName("started_at")).toBe("Started At");
  });

  it("handles single words", () => {
    expect(formatColumnName("name")).toBe("Name");
  });

  it("handles multiple underscores", () => {
    expect(formatColumnName("avg_heart_rate")).toBe("Avg Heart Rate");
  });
});

describe("formatCellValue", () => {
  it("returns em dash for null", () => {
    expect(formatCellValue(null)).toBe("—");
  });

  it("returns em dash for undefined", () => {
    expect(formatCellValue(undefined)).toBe("—");
  });

  it("returns 'Yes' for true", () => {
    expect(formatCellValue(true)).toBe("Yes");
  });

  it("returns 'No' for false", () => {
    expect(formatCellValue(false)).toBe("No");
  });

  it("returns JSON for objects", () => {
    expect(formatCellValue({ foo: 1 })).toBe('{"foo":1}');
  });

  it("formats ISO date strings", () => {
    const result = formatCellValue("2024-03-15T10:30:00Z");
    // formatTime returns locale-formatted string; just verify it doesn't return the raw ISO
    expect(result).not.toBe("2024-03-15T10:30:00Z");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns plain strings as-is", () => {
    expect(formatCellValue("hello")).toBe("hello");
  });

  it("converts numbers to strings", () => {
    expect(formatCellValue(42)).toBe("42");
  });
});

describe("RecordDetailModal", () => {
  const baseRecord: Record<string, unknown> = {
    id: "abc-123",
    name: "Morning Run",
    started_at: "2024-03-15T10:30:00Z",
    avg_hr: 145,
    max_hr: null,
    cadence: undefined,
    user_id: "user-1",
    raw: { source: "garmin", extra: "data" },
  };

  it("renders populated fields", () => {
    const { container } = render(<RecordDetailModal record={baseRecord} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Morning Run");
    expect(text).toContain("Id");
    expect(text).toContain("Avg Hr");
  });

  it("excludes raw and user_id from fields", () => {
    const { container } = render(<RecordDetailModal record={baseRecord} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("User Id");
  });

  it("shows null fields in collapsed section with count", () => {
    const { container } = render(<RecordDetailModal record={baseRecord} onClose={() => {}} />);
    const text = container.textContent ?? "";
    // max_hr and cadence are null/undefined
    expect(text).toContain("Empty Fields (2)");
  });

  it("does not show empty fields section when no null fields", () => {
    const record = { id: "1", name: "Test" };
    const { container } = render(<RecordDetailModal record={record} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Empty Fields");
  });

  it("renders raw provider data when present", () => {
    const { container } = render(<RecordDetailModal record={baseRecord} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Raw Provider Data");
    expect(text).toContain('"source"');
    expect(text).toContain('"garmin"');
  });

  it("does not render raw section when raw is absent", () => {
    const record = { id: "1", name: "Test" };
    const { container } = render(<RecordDetailModal record={record} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Raw Provider Data");
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(<RecordDetailModal record={baseRecord} onClose={onClose} />);
    const backdrop = queryButton(container, "Close dialog");
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when X button is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(<RecordDetailModal record={baseRecord} onClose={onClose} />);
    const closeButton = queryButton(container, "Close");
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not treat raw as an object when raw is a primitive", () => {
    const record = { id: "1", raw: "not-an-object" };
    const { container } = render(<RecordDetailModal record={record} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Raw Provider Data");
  });
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

  it("shows sync controls for non-import-only providers", async () => {
    mockProviders.data = [
      {
        id: "strong-csv",
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
});
