import { createMapStyle } from "@dofek/training/map-style";
import { StaticMapImageManager } from "@maplibre/maplibre-react-native";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeMapSnapshot } from "./native-map-snapshot";
import { captureException } from "./telemetry";

vi.mock("./telemetry", () => ({ captureException: vi.fn() }));
const options = {
  center: [-122, 37] satisfies [number, number],
  zoom: 12,
  width: 320,
  height: 180,
  mapStyle: createMapStyle("light"),
  output: "base64" satisfies "base64",
};
describe("useNativeMapSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("waits for a measured viewport and keeps processing until the image decodes", async () => {
    const view = renderHook(({ measured }) => useNativeMapSnapshot(measured ? options : null), {
      initialProps: { measured: false },
    });
    expect(StaticMapImageManager.createImage).not.toHaveBeenCalled();
    view.rerender({ measured: true });
    await waitFor(() => expect(view.result.current.uri).toBeTruthy());
    expect(view.result.current.ready).toBe(false);
    act(() => view.result.current.onLoad());
    expect(view.result.current.ready).toBe(true);
  });
  it("keeps a decoded image for an identical-content request after unrelated rerenders", async () => {
    const view = renderHook(({ request }) => useNativeMapSnapshot(request), {
      initialProps: { request: options },
    });
    await waitFor(() => expect(view.result.current.uri).toBeTruthy());
    act(() => view.result.current.onLoad());
    const uri = view.result.current.uri;
    view.rerender({
      request: { ...options, center: [-122, 37], mapStyle: createMapStyle("light") },
    });
    expect(StaticMapImageManager.createImage).toHaveBeenCalledOnce();
    expect(view.result.current.ready).toBe(true);
    expect(view.result.current.uri).toBe(uri);
  });

  it("reports native failures and does not retain a completed image after unmount", async () => {
    let reject: ((error: Error) => void) | undefined;
    vi.mocked(StaticMapImageManager.createImage).mockImplementationOnce(
      () =>
        new Promise((_resolve, rejectRequest) => {
          reject = rejectRequest;
        }),
    );
    const view = renderHook(() => useNativeMapSnapshot(options));
    view.unmount();
    const error = new Error("Snapshot failed");
    await act(async () => reject?.(error));
    expect(captureException).toHaveBeenCalledWith(error);
  });
});
