// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderGuide } from "./ProviderGuide";

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
