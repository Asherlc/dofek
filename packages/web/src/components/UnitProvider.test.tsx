// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUnitSystem } from "../lib/unitContext.ts";

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
    useQuery: vi.fn(),
  };
});

vi.mock("../lib/telemetry.ts", () => ({ captureException: mocks.captureException }));
vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    settings: {
      get: { useQuery: mocks.useQuery },
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

import { UnitProvider } from "./UnitProvider.tsx";

function UnitConsumer() {
  const { unitSystem, setUnitSystem } = useUnitSystem();
  return (
    <>
      <output data-testid="unit-system">{unitSystem}</output>
      <button type="button" onClick={() => setUnitSystem("imperial")}>
        Use imperial
      </button>
    </>
  );
}

function renderProvider() {
  return render(
    <UnitProvider settingsEnabled={true}>
      <UnitConsumer />
    </UnitProvider>,
  );
}

describe("UnitProvider", () => {
  beforeEach(() => {
    mocks.captureException.mockReset();
    mocks.getData.mockReset();
    mocks.invalidate.mockReset();
    mocks.mutate.mockReset();
    mocks.setData.mockReset();
    mocks.useQuery.mockReset();
    mocks.useQuery.mockReturnValue(mocks.query);
    mocks.query.data = undefined;
    mocks.query.error = null;
  });

  it("does not load protected settings when server settings are disabled", () => {
    render(
      <UnitProvider settingsEnabled={false}>
        <UnitConsumer />
      </UnitProvider>,
    );

    expect(mocks.useQuery).toHaveBeenCalledWith({ key: "unitSystem" }, { enabled: false });
  });

  it("loads protected settings when server settings are enabled", () => {
    render(
      <UnitProvider settingsEnabled={true}>
        <UnitConsumer />
      </UnitProvider>,
    );

    expect(mocks.useQuery).toHaveBeenCalledWith({ key: "unitSystem" }, { enabled: true });
  });

  it("preserves the loaded unit system and displays an exact background read error", async () => {
    mocks.query.data = { key: "unitSystem", value: "metric" };
    const view = renderProvider();
    await waitFor(() => expect(screen.getByTestId("unit-system").textContent).toBe("metric"));

    const readError = new Error("Unit settings could not be loaded.");
    mocks.query.error = readError;
    view.rerender(
      <UnitProvider settingsEnabled={true}>
        <UnitConsumer />
      </UnitProvider>,
    );

    expect(screen.getByTestId("unit-system").textContent).toBe("metric");
    expect(screen.getByRole("alert").textContent).toBe(readError.message);
    await waitFor(() =>
      expect(mocks.captureException).toHaveBeenCalledWith(readError, {
        context: "unit-system-read",
      }),
    );
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it("restores the exact unit state and cached setting after a failed optimistic write", async () => {
    const previousSetting = { key: "unitSystem", value: "metric" };
    mocks.query.data = previousSetting;
    mocks.getData.mockReturnValue(previousSetting);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("unit-system").textContent).toBe("metric"));

    fireEvent.click(screen.getByRole("button", { name: "Use imperial" }));
    expect(screen.getByTestId("unit-system").textContent).toBe("imperial");

    const options = mocks.mutate.mock.calls[0]?.[1];
    const writeError = new Error("Unit preference was not saved.");
    act(() => options.onError(writeError));
    act(() => options.onSettled());

    expect(screen.getByTestId("unit-system").textContent).toBe("metric");
    expect(mocks.setData).toHaveBeenLastCalledWith({ key: "unitSystem" }, previousSetting);
    expect(mocks.invalidate).toHaveBeenCalledWith({ key: "unitSystem" });
    expect(screen.getByRole("alert").textContent).toBe(writeError.message);
    expect(mocks.captureException).toHaveBeenCalledWith(writeError, {
      context: "unit-system-write",
    });
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });
});
