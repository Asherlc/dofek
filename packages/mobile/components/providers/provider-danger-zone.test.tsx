import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findNodeHandle: vi.fn<() => number | null | undefined>(),
  setAccessibilityFocus: vi.fn(),
  dailyMetricsRecordedInvalidate: vi.fn<() => Promise<void>>(),
  upcomingWorkoutsInvalidate: vi.fn<() => Promise<void>>(),
  deleteAllData: vi.fn(),
  deletionStatus: vi.fn(),
  otherInvalidate: vi.fn<() => Promise<void>>(),
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
  TextInput: ({
    onChangeText,
    placeholder,
    value,
  }: {
    onChangeText?: (text: string) => void;
    placeholder?: string;
    value?: string;
  }) =>
    createElement("input", {
      placeholder,
      value,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
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
    useUtils: () => ({
      dailyMetrics: { recorded: { invalidate: mocks.dailyMetricsRecordedInvalidate } },
      calendar: { upcomingWorkouts: { invalidate: mocks.upcomingWorkoutsInvalidate } },
      processing: { status: { invalidate: mocks.otherInvalidate } },
      sync: {
        providers: { invalidate: mocks.otherInvalidate },
        providerStats: { invalidate: mocks.otherInvalidate },
      },
      providerDetail: {
        logs: { invalidate: mocks.otherInvalidate },
        records: { invalidate: mocks.otherInvalidate },
      },
    }),
    providerDetail: {
      deleteAllData: {
        useMutation: () => ({ mutateAsync: mocks.deleteAllData, isPending: false }),
      },
      deletionStatus: { useQuery: mocks.deletionStatus },
      disconnect: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
  },
}));

import { ProviderDangerZone } from "./provider-danger-zone";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deleteAllData.mockResolvedValue({ operationId: "30000000-0000-4000-8000-000000000001" });
  mocks.deletionStatus.mockReturnValue({
    data: { status: "completed", message: "Provider data deletion completed." },
    error: null,
  });
  mocks.dailyMetricsRecordedInvalidate.mockResolvedValue(undefined);
  mocks.otherInvalidate.mockResolvedValue(undefined);
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

  it("invalidates calendar and provider-reported daily metrics when source deletion completes", async () => {
    render(
      <ProviderDangerZone
        canDisconnect={false}
        providerId="intervals.icu"
        providerName="Intervals.icu"
      />,
    );

    fireEvent.click(screen.getByLabelText("Delete All Data"));
    fireEvent.change(screen.getByPlaceholderText("DELETE"), { target: { value: "DELETE" } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Permanently Delete Data"));
    });

    await waitFor(() => expect(mocks.dailyMetricsRecordedInvalidate).toHaveBeenCalledOnce());
  });
});
