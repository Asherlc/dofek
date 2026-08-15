/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupplementStackPanel } from "./SupplementStackPanel.tsx";

interface QueryState {
  data: Array<{ name: string; amount?: number; unit?: string }> | undefined;
  error: Error | null;
  isLoading: boolean;
}

const mocks = vi.hoisted<{
  query: QueryState;
}>(() => ({
  query: {
    data: [{ name: "Creatine", amount: 5, unit: "g" }],
    error: null,
    isLoading: false,
  },
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    supplements: {
      list: { useQuery: () => mocks.query },
    },
  },
}));

describe("SupplementStackPanel", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.query.data = [{ name: "Creatine", amount: 5, unit: "g" }];
    mocks.query.error = null;
    mocks.query.isLoading = false;
    vi.clearAllMocks();
  });

  it("uses the shared query state panel while the stack initially loads", () => {
    mocks.query.data = undefined;
    mocks.query.isLoading = true;

    render(<SupplementStackPanel />);

    expect(screen.getByTestId("query-state-loading")).toBeDefined();
  });

  it("uses the shared query state panel for an empty synced stack", () => {
    mocks.query.data = [];

    render(<SupplementStackPanel />);

    expect(screen.getByTestId("query-state-empty")).toBeDefined();
    expect(screen.getByText("No synced supplements available.")).toBeDefined();
  });

  it("preserves cached supplements during a background refresh failure", () => {
    mocks.query.error = new Error("Supplement refresh failed.");

    render(<SupplementStackPanel />);

    expect(screen.getByText("Creatine")).toBeDefined();
    expect(screen.getByText("Supplement refresh failed.")).toBeDefined();
  });
});
