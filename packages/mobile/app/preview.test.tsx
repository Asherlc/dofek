// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockCheckAndApply } = vi.hoisted(() => ({
  mockCheckAndApply: vi.fn(),
}));

vi.mock("../lib/preview-update", () => ({
  checkAndApplyPreviewUpdate: mockCheckAndApply,
}));

vi.mock("expo-updates", () => ({
  channel: "preview",
  updateId: null,
  runtimeVersion: "1.0",
  createdAt: null,
  isEmbeddedLaunch: true,
}));

const mockSearchParams = { pr: "42" };
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: vi.fn() }),
}));

describe("PreviewScreen", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("shows loading state with PR number", async () => {
    mockCheckAndApply.mockImplementation(() => new Promise(() => {}));

    const { default: PreviewScreen } = await import("./preview");

    render(<PreviewScreen />);

    expect(screen.getByText((text) => text.includes("PR #42"))).toBeTruthy();
  });

  it("triggers update check on mount", async () => {
    mockCheckAndApply.mockResolvedValue({ status: "reloading" });

    const { default: PreviewScreen } = await import("./preview");

    render(<PreviewScreen />);

    await waitFor(() => {
      expect(mockCheckAndApply).toHaveBeenCalledOnce();
    });
  });

  it("shows error message when update fails", async () => {
    mockCheckAndApply.mockResolvedValue({
      status: "error",
      message: "Network error",
    });

    const { default: PreviewScreen } = await import("./preview");

    render(<PreviewScreen />);

    await waitFor(() => {
      expect(screen.getByText((text) => text.includes("Network error"))).toBeTruthy();
    });
  });

  it("shows no-update message when already up to date", async () => {
    mockCheckAndApply.mockResolvedValue({ status: "no-update" });

    const { default: PreviewScreen } = await import("./preview");

    render(<PreviewScreen />);

    await waitFor(() => {
      expect(screen.getByText((text) => text.includes("No update available"))).toBeTruthy();
    });
  });
});
