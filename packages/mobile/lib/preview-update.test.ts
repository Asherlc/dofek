import { afterEach, describe, expect, it, vi } from "vitest";

const { mockCheckForUpdateAsync, mockFetchUpdateAsync, mockReloadAsync, mockCaptureException } =
  vi.hoisted(() => ({
    mockCheckForUpdateAsync: vi.fn(),
    mockFetchUpdateAsync: vi.fn(),
    mockReloadAsync: vi.fn(),
    mockCaptureException: vi.fn(),
  }));

vi.mock("expo-updates", () => ({
  checkForUpdateAsync: mockCheckForUpdateAsync,
  fetchUpdateAsync: mockFetchUpdateAsync,
  reloadAsync: mockReloadAsync,
  channel: "preview",
  updateId: null,
  runtimeVersion: "1.0",
  createdAt: null,
  isEmbeddedLaunch: true,
}));

vi.mock("./telemetry", () => ({
  captureException: mockCaptureException,
}));

import { checkAndApplyPreviewUpdate } from "./preview-update";

describe("checkAndApplyPreviewUpdate", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns 'no-update' when no update is available", async () => {
    mockCheckForUpdateAsync.mockResolvedValue({ isAvailable: false });

    const result = await checkAndApplyPreviewUpdate();

    expect(result).toEqual({ status: "no-update" });
    expect(mockCheckForUpdateAsync).toHaveBeenCalledOnce();
    expect(mockFetchUpdateAsync).not.toHaveBeenCalled();
    expect(mockReloadAsync).not.toHaveBeenCalled();
  });

  it("fetches and reloads when an update is available", async () => {
    mockCheckForUpdateAsync.mockResolvedValue({ isAvailable: true });
    mockFetchUpdateAsync.mockResolvedValue({ isNew: true });
    mockReloadAsync.mockResolvedValue(undefined);

    const result = await checkAndApplyPreviewUpdate();

    expect(result).toEqual({ status: "reloading" });
    expect(mockCheckForUpdateAsync).toHaveBeenCalledOnce();
    expect(mockFetchUpdateAsync).toHaveBeenCalledOnce();
    expect(mockReloadAsync).toHaveBeenCalledOnce();
  });

  it("returns 'no-update' when fetch says the update is not new", async () => {
    mockCheckForUpdateAsync.mockResolvedValue({ isAvailable: true });
    mockFetchUpdateAsync.mockResolvedValue({ isNew: false });

    const result = await checkAndApplyPreviewUpdate();

    expect(result).toEqual({ status: "no-update" });
    expect(mockReloadAsync).not.toHaveBeenCalled();
  });

  it("returns 'error' and reports to telemetry on check failure", async () => {
    const error = new Error("Network error");
    mockCheckForUpdateAsync.mockRejectedValue(error);

    const result = await checkAndApplyPreviewUpdate();

    expect(result).toEqual({ status: "error", message: "Network error" });
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      source: "preview-update",
    });
  });

  it("returns 'error' and reports to telemetry on fetch failure", async () => {
    const error = new Error("Download failed");
    mockCheckForUpdateAsync.mockResolvedValue({ isAvailable: true });
    mockFetchUpdateAsync.mockRejectedValue(error);

    const result = await checkAndApplyPreviewUpdate();

    expect(result).toEqual({ status: "error", message: "Download failed" });
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      source: "preview-update",
    });
  });
});
