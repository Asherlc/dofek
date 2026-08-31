/** @vitest-environment jsdom */

import { act, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { mockRootRender, mockUseApp } = vi.hoisted(() => ({
  mockRootRender: vi.fn(),
  mockUseApp: vi.fn(),
}));

vi.mock("@modelcontextprotocol/ext-apps/react", () => ({ useApp: mockUseApp }));
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: mockRootRender }),
}));
vi.mock("./health-explorer.tsx", () => ({
  HealthExplorer: ({ snapshot }: { snapshot: { series: Array<{ label: string }> } }) => (
    <p>{snapshot.series[0]?.label ?? "No series"}</p>
  ),
}));

const createdApp: { ontoolresult?: (result: { structuredContent: unknown }) => void } = {};

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>';
  mockUseApp.mockImplementation((options: { onAppCreated(app: typeof createdApp): void }) => {
    options.onAppCreated(createdApp);
    return { app: null, isConnected: true, error: null };
  });
  await import("./main.tsx");
});

describe("ExplorerApp", () => {
  it("surfaces an invalid tool result and recovers when a valid result arrives", () => {
    render(mockRootRender.mock.calls[0]?.[0]);

    act(() => createdApp.ontoolresult?.({ structuredContent: {} }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Dofek Explorer received an invalid response from the server. Please try again.",
    );

    act(() =>
      createdApp.ontoolresult?.({
        structuredContent: {
          range: { start_date: "2026-08-01", end_date: "2026-08-01", granularity: "daily" },
          series: [
            {
              metric: "hrv",
              label: "Heart rate variability",
              unit: "ms",
              points: [{ key: "2026-08-01", value: 51 }],
            },
          ],
          summary: [{ metric: "hrv", average: 51, min: 51, max: 51 }],
          coverage: { observed_days: 1, requested_days: 1 },
        },
      }),
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Heart rate variability")).toBeDefined();
  });
});
