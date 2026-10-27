import { fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findNodeHandle: vi.fn<() => number | null | undefined>(),
  setAccessibilityFocus: vi.fn(),
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: { setAccessibilityFocus: mocks.setAccessibilityFocus },
  Alert: { alert: vi.fn() },
  findNodeHandle: mocks.findNodeHandle,
  Modal: ({
    children,
    onShow,
    visible,
  }: {
    children?: ReactNode;
    onShow?: () => void;
    visible: boolean;
  }) => {
    useEffect(() => {
      if (visible) onShow?.();
    }, [onShow, visible]);
    return visible ? createElement("div", { role: "dialog" }, children) : null;
  },
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  TextInput: "input",
  TouchableOpacity: ({
    accessibilityLabel,
    children,
    onPress,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
    onPress?: () => void;
  }) =>
    createElement(
      "button",
      { type: "button", "aria-label": accessibilityLabel, onClick: onPress },
      children,
    ),
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));

vi.mock("../../lib/telemetry", () => ({ captureException: vi.fn() }));
vi.mock("../../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    providerDetail: {
      deleteAllData: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      deletionStatus: { useQuery: () => ({}) },
      disconnect: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
  },
}));

import { ProviderDangerZone } from "./provider-danger-zone";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProviderDangerZone", () => {
  it("focuses the cancel action when the disconnect dialog has a native node", () => {
    mocks.findNodeHandle.mockReturnValue(42);
    render(<ProviderDangerZone canDisconnect providerId="wahoo" providerName="Wahoo" />);

    fireEvent.click(screen.getByLabelText("Disconnect Wahoo"));

    expect(mocks.setAccessibilityFocus).toHaveBeenCalledWith(42);
  });

  it.each([null, undefined])("keeps the dialog usable when its native node is %s", (node) => {
    mocks.findNodeHandle.mockReturnValue(node);
    render(<ProviderDangerZone canDisconnect providerId="wahoo" providerName="Wahoo" />);

    fireEvent.click(screen.getByLabelText("Disconnect Wahoo"));

    expect(mocks.setAccessibilityFocus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Cancel disconnect"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
