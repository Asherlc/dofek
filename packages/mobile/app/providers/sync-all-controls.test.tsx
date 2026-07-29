// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

const setAccessibilityFocus = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => {
  const ReactModule = require("react");
  const View = ({ children, style: _style, ...props }: Record<string, unknown>) =>
    ReactModule.createElement("div", props, children);
  const Text = ({
    children,
    accessibilityRole,
    style: _style,
    ...props
  }: Record<string, unknown>) =>
    ReactModule.createElement("span", { role: accessibilityRole, ...props }, children);
  const TouchableOpacity = ReactModule.forwardRef(
    (
      {
        accessibilityLabel,
        accessibilityRole,
        accessibilityState,
        activeOpacity: _activeOpacity,
        children,
        disabled,
        onPress,
        style: _style,
        ...props
      }: Record<string, unknown>,
      ref: React.Ref<HTMLButtonElement>,
    ) =>
      ReactModule.createElement(
        "button",
        {
          ...props,
          ref,
          "aria-busy":
            typeof accessibilityState === "object" &&
            accessibilityState !== null &&
            "busy" in accessibilityState
              ? accessibilityState.busy
              : undefined,
          "aria-disabled":
            typeof accessibilityState === "object" &&
            accessibilityState !== null &&
            "disabled" in accessibilityState
              ? accessibilityState.disabled
              : undefined,
          "aria-label": accessibilityLabel,
          disabled,
          onClick: onPress,
          role: accessibilityRole,
          type: "button",
        },
        children,
      ),
  );
  const Modal = ({
    children,
    onRequestClose,
    onShow,
    visible,
  }: {
    children?: React.ReactNode;
    onRequestClose?: () => void;
    onShow?: () => void;
    visible?: boolean;
  }) => {
    ReactModule.useEffect(() => {
      if (visible) onShow?.();
    }, [onShow, visible]);
    return visible
      ? ReactModule.createElement(
          "div",
          { role: "dialog", onClick: onRequestClose, "aria-label": "Full sync confirmation" },
          children,
        )
      : null;
  };
  return {
    AccessibilityInfo: { setAccessibilityFocus },
    ActivityIndicator: () => ReactModule.createElement("span", { role: "progressbar" }),
    findNodeHandle: () => 42,
    Modal,
    StyleSheet: { create: (styles: Record<string, unknown>) => styles },
    Text,
    TouchableOpacity,
    View,
  };
});

vi.mock("../../theme", () => ({
  colors: {
    accent: "#00aaff",
    background: "#000000",
    danger: "#ff0000",
    surface: "#111111",
    surfaceSecondary: "#222222",
    text: "#ffffff",
    textSecondary: "#aaaaaa",
  },
}));

import { SyncAllControls } from "./sync-all-controls.tsx";

describe("SyncAllControls", () => {
  it("makes recent sync the directly available primary action", () => {
    const onRecentSync = vi.fn();
    render(<SyncAllControls busy={false} onRecentSync={onRecentSync} onFullSync={vi.fn()} />);

    const recent = screen.getByRole("button", {
      name: "Sync all providers for the last 7 days",
    });
    const full = screen.getByRole("button", {
      name: "Sync full history for all providers",
    });

    expect(recent.compareDocumentPosition(full) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Updates the last 7 days for every connected provider.")).toBeTruthy();
    fireEvent.click(recent);
    expect(onRecentSync).toHaveBeenCalledOnce();
  });

  it("requires confirmation after explaining full-history impact", () => {
    const onFullSync = vi.fn();
    render(<SyncAllControls busy={false} onRecentSync={vi.fn()} onFullSync={onFullSync} />);

    fireEvent.click(screen.getByRole("button", { name: "Sync full history for all providers" }));

    const dialog = screen.getByRole("dialog", { name: "Full sync confirmation" });
    expect(within(dialog).getByText("Sync full provider history?")).toBeTruthy();
    expect(
      within(dialog).getByText(/all history each connected provider makes available/i),
    ).toBeTruthy();
    expect(within(dialog).getByText(/more provider requests/i)).toBeTruthy();
    expect(within(dialog).getByText(/matching records are updated/i)).toBeTruthy();
    expect(within(dialog).getByText(/activities removed upstream may be hidden/i)).toBeTruthy();
    expect(onFullSync).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Start full sync" }));
    expect(onFullSync).toHaveBeenCalledOnce();
  });

  it("puts Cancel first, moves accessibility focus to it, and treats request-close as cancel", async () => {
    const onFullSync = vi.fn();
    render(<SyncAllControls busy={false} onRecentSync={vi.fn()} onFullSync={onFullSync} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync full history for all providers" }));

    const dialog = screen.getByRole("dialog", { name: "Full sync confirmation" });
    const actions = within(dialog).getAllByRole("button");
    expect(actions.map((action) => action.textContent)).toEqual(["Cancel", "Start full sync"]);
    await waitFor(() => expect(setAccessibilityFocus).toHaveBeenCalledWith(42));

    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onFullSync).not.toHaveBeenCalled();
  });

  it("disables both actions and exposes progress while work is active", () => {
    render(<SyncAllControls busy onRecentSync={vi.fn()} onFullSync={vi.fn()} />);

    expect(
      screen
        .getByRole("button", { name: "Sync all providers for the last 7 days" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Sync full history for all providers" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText("Sync in progress. Follow each provider below for progress.").textContent,
    ).toContain("Follow each provider below");
  });

  it("shows the exact trigger error", () => {
    render(
      <SyncAllControls
        busy={false}
        errorMessage="Garmin credentials expired. Reconnect Garmin."
        onRecentSync={vi.fn()}
        onFullSync={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Garmin credentials expired. Reconnect Garmin.",
    );
  });
});
