// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { ProviderGuide } from "./ProviderGuide";

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("react-native", () => ({
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles,
  },
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
  TouchableOpacity: ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) =>
    React.createElement("button", { onClick: onPress, type: "button" }, children),
  View: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

describe("ProviderGuide", () => {
  it("shows restored providers under their matching categories", () => {
    render(
      <ProviderGuide
        onDismiss={vi.fn()}
        providers={[
          { id: "cycling_analytics", name: "Cycling Analytics", authorized: false },
          { id: "bodyspec", name: "BodySpec", authorized: false },
        ]}
      />,
    );

    expect(screen.getByText("Cycling Analytics")).toBeTruthy();
    expect(screen.getByText("BodySpec")).toBeTruthy();
    expect(screen.getByText("Activity Tracking")).toBeTruthy();
    expect(screen.getByText("Body Composition")).toBeTruthy();
  });
});
