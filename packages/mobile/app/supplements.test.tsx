// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface QueryState {
  data: Array<{ name: string; amount?: number; unit?: string }> | undefined;
  error: Error | null;
  isLoading: boolean;
}

interface SaveOptions {
  meta?: unknown;
  onError?: (error: Error) => void;
}

const mocks = vi.hoisted<{
  captureException: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
  mutate: ReturnType<typeof vi.fn>;
  query: QueryState;
  saveOptions: SaveOptions | undefined;
}>(() => ({
  captureException: vi.fn(),
  invalidate: vi.fn(),
  mutate: vi.fn(),
  query: {
    data: [{ name: "Creatine", amount: 5, unit: "g" }],
    error: null,
    isLoading: false,
  },
  saveOptions: undefined,
}));

vi.mock("../lib/telemetry", () => ({
  captureException: mocks.captureException,
}));

vi.mock("../lib/useRefresh", () => ({
  useRefresh: () => ({ onRefresh: vi.fn(), refreshing: false }),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      invalidate: mocks.invalidate,
      supplements: { list: { invalidate: mocks.invalidate } },
    }),
    supplements: {
      list: { useQuery: () => mocks.query },
      occurrences: {
        useQuery: () => ({
          data: {
            occurrences: [],
            counts: { planned: 0, taken: 0, skipped: 0, unknown: 0 },
          },
          error: null,
          isLoading: false,
        }),
      },
      recordDose: {
        useMutation: () => ({
          error: null,
          isError: false,
          isPending: false,
          mutate: vi.fn(),
        }),
      },
      save: {
        useMutation: (options: typeof mocks.saveOptions) => {
          mocks.saveOptions = options;
          return {
            error: null,
            isError: false,
            isPending: false,
            mutate: mocks.mutate,
          };
        },
      },
    },
  },
}));

describe("SupplementsScreen", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.query.data = [{ name: "Creatine", amount: 5, unit: "g" }];
    mocks.query.error = null;
    mocks.query.isLoading = false;
    mocks.saveOptions = undefined;
    vi.clearAllMocks();
  });

  it("disables replacement actions when a previously loaded stack fails to reload", async () => {
    const { default: SupplementsScreen } = await import("./supplements");
    const { rerender } = render(<SupplementsScreen />);

    mocks.query.data = undefined;
    mocks.query.error = new Error("Supplement stack is unavailable.");
    rerender(<SupplementsScreen />);

    expect(screen.getByText("Supplement stack is unavailable.")).toBeTruthy();
    expect(screen.queryByText(/No supplements configured/)).toBeNull();
    expect(screen.getByRole("button", { name: "Add Supplement" })).toHaveProperty("disabled", true);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("preserves cached supplements during a background refresh failure", async () => {
    mocks.query.error = new Error("Supplement refresh failed.");
    const { default: SupplementsScreen } = await import("./supplements");

    render(<SupplementsScreen />);

    expect(screen.getByText("Creatine")).toBeTruthy();
    expect(screen.getByText("Refresh failed: Supplement refresh failed.")).toBeTruthy();
  });

  it("reports failed replacement mutations", async () => {
    const saveError = new Error("Supplement stack changed. Reload and try again.");
    const { default: SupplementsScreen } = await import("./supplements");
    render(<SupplementsScreen />);

    mocks.saveOptions?.onError?.(saveError);

    expect(mocks.saveOptions?.meta).toEqual({ errorReportedLocally: true });
    expect(mocks.captureException).toHaveBeenCalledWith(saveError, {
      operation: "supplements.save",
    });
  });
});
