import type { ActivityMetricSource } from "@dofek/providers/activity-metric-source";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActivityMetricSourcePicker } from "./ActivityMetricSourcePicker";

const sources: ActivityMetricSource[] = [
  {
    id: "opaque-watch",
    label: "Asher’s Apple Watch (via Apple Health; recorded by Workout)",
    presentation: {
      displayName: "Asher’s Apple Watch",
      providerId: "apple_health",
      sourceName: "Asher’s Apple Watch",
      attribution: { kind: "apple_health", label: "via Apple Health" },
    },
  },
  {
    id: "opaque-cloud",
    label: "WHOOP (via WHOOP Cloud)",
    presentation: {
      displayName: "WHOOP",
      providerId: "whoop",
      sourceName: null,
      attribution: { kind: "cloud", label: "via WHOOP Cloud" },
    },
  },
  {
    id: "opaque-bluetooth",
    label: "WHOOP (via Bluetooth)",
    presentation: {
      displayName: "WHOOP",
      providerId: "whoop",
      sourceName: null,
      attribution: { kind: "bluetooth", label: "via Bluetooth" },
    },
  },
];

describe("ActivityMetricSourcePicker", () => {
  it.each([true, false])("keeps full attribution accessible with showLabel=%s", (showLabel) => {
    render(
      <ActivityMetricSourcePicker
        label="Elevation"
        showLabel={showLabel}
        serverUrl="https://api.example.test"
        sources={sources}
        selectedId="opaque-watch"
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: `Elevation source: ${sources[0]?.label}` });
    expect(trigger.textContent).toBe(`${showLabel ? "Elevation · " : ""}Asher’s Apple Watch`);
    expect(trigger.style.minHeight).toBe("44px");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(
      trigger.querySelector('[uri="https://api.example.test/logos/apple-watch.svg"]'),
    ).toBeTruthy();
    expect(trigger.querySelectorAll("Image")).toHaveLength(1);
    expect(within(trigger).queryByText(/via Apple Health/)).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("radio", { name: sources[0]?.label, checked: true }).textContent).toBe(
      sources[0]?.label,
    );
  });

  it.each([
    ["opaque-cloud", "cloud-outline", "WHOOP (via WHOOP Cloud)"],
    ["opaque-bluetooth", "bluetooth-outline", "WHOOP (via Bluetooth)"],
  ])("uses the structured attribution icon for %s", (selectedId, icon, fullLabel) => {
    render(
      <ActivityMetricSourcePicker
        label="Heart Rate"
        sources={sources}
        selectedId={selectedId}
        serverUrl=""
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: `Heart Rate source: ${fullLabel}` });
    expect(trigger.querySelector(`[data-icon="${icon}"]`)).toBeTruthy();
    expect(trigger.querySelector('[data-icon="chevron-down"]')).toBeTruthy();
    expect(trigger.textContent).toBe("Heart Rate · WHOOP");
  });

  it("distinguishes duplicate names and switches by source ID", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ActivityMetricSourcePicker
        label="Heart Rate"
        sources={sources}
        selectedId="opaque-cloud"
        serverUrl=""
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Heart Rate source: WHOOP (via WHOOP Cloud)" }),
    );
    expect(
      screen.getByRole("radio", { name: "WHOOP (via WHOOP Cloud)", checked: true }),
    ).toBeTruthy();
    const bluetoothChoice = screen.getByRole("radio", {
      name: "WHOOP (via Bluetooth)",
      checked: false,
    });
    expect(bluetoothChoice.style.minHeight).toBe("44px");
    fireEvent.click(bluetoothChoice);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("opaque-bluetooth");
    expect(screen.queryByRole("radio")).toBeNull();
    rerender(
      <ActivityMetricSourcePicker
        label="Heart Rate"
        sources={sources}
        selectedId="opaque-bluetooth"
        serverUrl=""
        onChange={onChange}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Heart Rate source: WHOOP (via Bluetooth)" }).textContent,
    ).toBe("Heart Rate · WHOOP");
  });

  it("dismisses the chooser without changing the selected source", () => {
    const onChange = vi.fn();
    render(
      <ActivityMetricSourcePicker
        label="Heart Rate"
        sources={sources}
        selectedId="opaque-cloud"
        serverUrl=""
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Heart Rate source: WHOOP (via WHOOP Cloud)" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("radio")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
