/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupplementStackPanel } from "./SupplementStackPanel.tsx";

interface QueryState {
  data: Array<{ id: string; name: string; amount?: number; unit?: string }> | undefined;
  error: Error | null;
  isLoading: boolean;
}

const mocks = vi.hoisted<{
  query: QueryState;
}>(() => ({
  query: {
    data: [{ id: "definition-1", name: "Creatine", amount: 5, unit: "g" }],
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
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mocks.query.data = [{ id: "definition-1", name: "Creatine", amount: 5, unit: "g" }];
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

  it("shows the server error when the initial stack load fails", () => {
    mocks.query.data = undefined;
    mocks.query.error = new Error("Supplement load failed.");

    render(<SupplementStackPanel />);

    expect(screen.getByText("Supplement load failed.")).toBeDefined();
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

  it("renders duplicate synced supplements without duplicate React keys", () => {
    mocks.query.data = [
      { id: "definition-1", name: "Creatine", amount: 5, unit: "g" },
      { id: "definition-2", name: "Creatine", amount: 5, unit: "g" },
    ];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<SupplementStackPanel />);

    expect(screen.getAllByText("Creatine")).toHaveLength(2);
    expect(
      consoleError.mock.calls.filter(([message]) => String(message).includes("same key")),
    ).toHaveLength(0);
  });
});
