import type { ActivityOrigin } from "@dofek/providers/activity-origin";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AccessibilityInfo } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivitySourceDisclosure } from "./ActivitySourceDisclosure";

vi.mock("./ProviderLogo", () => ({
  ProviderLogo: ({ provider, sourceName }: { provider: string; sourceName?: string }) => (
    <span data-testid="provider-logo" data-provider={provider} data-source-name={sourceName} />
  ),
}));

function origin(providerId: string, sourceName: string | null = null): ActivityOrigin {
  return {
    status: "resolved",
    memberActivityId: "00000000-0000-4000-8000-000000000001",
    providerId,
    sourceName,
  };
}

describe("ActivitySourceDisclosure", () => {
  beforeEach(() => vi.mocked(AccessibilityInfo.sendAccessibilityEvent).mockClear());

  it("opens a direct recording's source and closes it explicitly", () => {
    render(<ActivitySourceDisclosure origin={origin("whoop")} />);
    const trigger = screen.getByRole("button", { name: "Activity source: WHOOP (Cloud)" });
    expect(trigger.style.minWidth).toBe("44px");
    expect(trigger.style.minHeight).toBe("44px");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).not.toContain("WHOOP");
    expect(screen.queryByText("Recorded in")).toBeNull();

    fireEvent.click(trigger);

    expect(screen.getByText("Recorded in")).toBeDefined();
    expect(screen.getByText("WHOOP (Cloud)")).toBeDefined();
    expect(screen.queryByText("Imported via")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close activity source details" }));
    expect(screen.queryByText("Recorded in")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(AccessibilityInfo.sendAccessibilityEvent).toHaveBeenCalledWith(trigger, "focus");
  });

  it("uses a clean Hang Ten logo and separates Apple Health's import role", () => {
    render(<ActivitySourceDisclosure origin={origin("apple_health", "Hang Ten Training")} />);
    const trigger = screen.getByRole("button", { name: "Activity source: Hang Ten" });
    const logo = within(trigger).getByTestId("provider-logo");
    expect(logo.getAttribute("data-provider")).toBe("hang-ten");
    expect(logo.getAttribute("data-source-name")).toBeNull();
    expect(trigger.textContent).not.toContain("Hang Ten");

    fireEvent.click(trigger);

    expect(screen.getByText("Recorded in").parentElement?.textContent).toContain("Hang Ten");
    expect(screen.getByText("Imported via").parentElement?.textContent).toContain("Apple Health");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss activity source details" }));
    expect(screen.queryByText("Imported via")).toBeNull();
  });

  it("preserves an unrecognized recording app's name", () => {
    render(<ActivitySourceDisclosure origin={origin("apple_health", "My Training App")} />);
    fireEvent.click(screen.getByRole("button", { name: "Activity source: My Training App" }));
    expect(screen.getByText("My Training App")).toBeDefined();
    expect(screen.getByText("Apple Health")).toBeDefined();
  });

  it("dismisses on the modal's system close request", () => {
    render(<ActivitySourceDisclosure origin={origin("whoop")} />);
    const trigger = screen.getByRole("button", { name: "Activity source: WHOOP (Cloud)" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByLabelText("Activity source details"), {
      key: "Escape",
    });
    expect(screen.queryByText("Recorded in")).toBeNull();
    expect(AccessibilityInfo.sendAccessibilityEvent).toHaveBeenCalledWith(trigger, "focus");
  });

  it("does not claim a source when recording origin is unresolved", () => {
    render(
      <ActivitySourceDisclosure
        origin={{ status: "unresolved", candidateMemberActivityIds: [] }}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
