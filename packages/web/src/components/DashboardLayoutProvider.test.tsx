// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDashboardLayout } from "../lib/dashboardLayoutContext.ts";

interface MockSettingsQuery {
  data: { key: string; value: unknown } | undefined;
  error: Error | null;
}

const mocks = vi.hoisted(() => {
  const query: MockSettingsQuery = {
    data: undefined,
    error: null,
  };
  return {
    captureException: vi.fn(),
    getData: vi.fn(),
    invalidate: vi.fn(),
    mutate: vi.fn(),
    query,
    setData: vi.fn(),
  };
});

vi.mock("../lib/telemetry.ts", () => ({ captureException: mocks.captureException }));
vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    settings: {
      get: { useQuery: () => mocks.query },
      set: { useMutation: () => ({ mutate: mocks.mutate }) },
    },
    useUtils: () => ({
      settings: {
        get: {
          getData: mocks.getData,
          invalidate: mocks.invalidate,
          setData: mocks.setData,
        },
      },
    }),
  },
}));

import { DashboardLayoutProvider } from "./DashboardLayoutProvider.tsx";

function LayoutConsumer() {
  const { layout, toggleHidden } = useDashboardLayout();
  return (
    <>
      <output data-testid="hidden">{layout.hidden.join(",")}</output>
      <button type="button" onClick={() => toggleHidden("sleep")}>
        Toggle sleep
      </button>
    </>
  );
}

function renderProvider() {
  return render(
    <DashboardLayoutProvider>
      <LayoutConsumer />
    </DashboardLayoutProvider>,
  );
}

describe("DashboardLayoutProvider", () => {
  beforeEach(() => {
    mocks.captureException.mockReset();
    mocks.getData.mockReset();
    mocks.invalidate.mockReset();
    mocks.mutate.mockReset();
    mocks.setData.mockReset();
    mocks.query.data = undefined;
    mocks.query.error = null;
  });

  it("safely rejects a corrupt legacy layout string without crashing", async () => {
    mocks.query.data = { key: "dashboardLayout", value: "{not-json" };

    renderProvider();

    expect(screen.getByTestId("hidden").textContent).toBe("");
    await waitFor(() => expect(mocks.captureException).toHaveBeenCalledTimes(1));
  });

  it("preserves the loaded layout and displays an exact background read error", async () => {
    mocks.query.data = {
      key: "dashboardLayout",
      value: JSON.stringify({ order: ["sleep"], hidden: ["sleep"], collapsed: {} }),
    };
    const view = renderProvider();
    await waitFor(() => expect(screen.getByTestId("hidden").textContent).toBe("sleep"));

    const readError = new Error("Dashboard settings are temporarily unavailable.");
    mocks.query.error = readError;
    view.rerender(
      <DashboardLayoutProvider>
        <LayoutConsumer />
      </DashboardLayoutProvider>,
    );

    expect(screen.getByTestId("hidden").textContent).toBe("sleep");
    expect(screen.getByRole("alert").textContent).toBe(readError.message);
    await waitFor(() =>
      expect(mocks.captureException).toHaveBeenCalledWith(readError, {
        context: "dashboard-layout-read",
      }),
    );
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it("restores the exact layout and cached setting after a failed optimistic write", async () => {
    const previousLayout = {
      order: ["sleep"],
      hidden: ["sleep"],
      collapsed: { sleep: false },
    };
    const previousSetting = { key: "dashboardLayout", value: previousLayout };
    mocks.query.data = previousSetting;
    mocks.getData.mockReturnValue(previousSetting);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("hidden").textContent).toBe("sleep"));

    fireEvent.click(screen.getByRole("button", { name: "Toggle sleep" }));
    expect(screen.getByTestId("hidden").textContent).toBe("");

    const options = mocks.mutate.mock.calls[0]?.[1];
    const writeError = new Error("Dashboard layout could not be saved.");
    act(() => options.onError(writeError));

    expect(screen.getByTestId("hidden").textContent).toBe("sleep");
    expect(mocks.setData).toHaveBeenLastCalledWith({ key: "dashboardLayout" }, previousSetting);
    expect(screen.getByRole("alert").textContent).toBe(writeError.message);
    expect(mocks.captureException).toHaveBeenCalledWith(writeError, {
      context: "dashboard-layout-write",
    });
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });
});
