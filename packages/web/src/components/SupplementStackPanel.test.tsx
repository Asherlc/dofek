/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locallyReportedErrorMeta } from "../lib/query-client.ts";
import { SupplementStackPanel } from "./SupplementStackPanel.tsx";

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

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mocks.captureException,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      supplements: { list: { invalidate: mocks.invalidate } },
    }),
    supplements: {
      list: { useQuery: () => mocks.query },
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

describe("SupplementStackPanel", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.query.data = [{ name: "Creatine", amount: 5, unit: "g" }];
    mocks.query.error = null;
    mocks.query.isLoading = false;
    mocks.saveOptions = undefined;
    vi.clearAllMocks();
  });

  it("blocks replacement actions when a previously loaded stack fails to reload", () => {
    const { rerender } = render(<SupplementStackPanel />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add supplement" }));

    mocks.query.data = undefined;
    mocks.query.error = new Error("Supplement stack is unavailable.");
    rerender(<SupplementStackPanel />);

    expect(screen.getByText("Supplement stack is unavailable.")).toBeDefined();
    expect(screen.queryByText("No supplements configured.")).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Add supplement" })).toBeNull();
    expect(screen.queryByPlaceholderText("e.g., Creatine Monohydrate")).toBeNull();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("uses the shared query state panel while the stack initially loads", () => {
    mocks.query.data = undefined;
    mocks.query.isLoading = true;

    render(<SupplementStackPanel />);

    expect(screen.getByTestId("query-state-loading")).toBeDefined();
  });

  it("uses the shared query state panel for an empty stack", () => {
    mocks.query.data = [];

    render(<SupplementStackPanel />);

    expect(screen.getByTestId("query-state-empty")).toBeDefined();
    expect(screen.getByText(/No supplements configured/)).toBeDefined();
  });

  it("preserves cached supplements during a background refresh failure", () => {
    mocks.query.error = new Error("Supplement refresh failed.");

    render(<SupplementStackPanel />);

    expect(screen.getByText("Creatine")).toBeDefined();
    expect(screen.getByText("Supplement refresh failed.")).toBeDefined();
    expect(screen.getByRole("button", { name: "+ Add supplement" })).toBeDefined();
  });

  it("reports failed replacement mutations and exposes the server error", () => {
    const saveError = new Error("Supplement stack changed. Reload and try again.");
    render(<SupplementStackPanel />);

    act(() => mocks.saveOptions?.onError?.(saveError));

    expect(mocks.saveOptions?.meta).toBe(locallyReportedErrorMeta);
    expect(mocks.captureException).toHaveBeenCalledWith(saveError, {
      operation: "supplements.save",
    });
  });
});
