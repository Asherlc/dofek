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
  it("uses provider logos while retaining device names and complete accessible choices", () => {
    const choices: ActivityMetricSource[] = [
      {
        id: "peloton",
        label: "Peloton",
        presentation: {
          displayName: "Peloton",
          providerId: "peloton",
          sourceName: null,
          attribution: null,
        },
      },
      {
        id: "strava-bike",
        label: "Strava · recorded by Peloton Bike",
        presentation: {
          displayName: "Peloton Bike",
          providerId: "strava",
          sourceName: null,
          attribution: null,
        },
      },
    ];
    const onChange = vi.fn();
    const { rerender } = render(
      <ActivityMetricSourcePicker
        label="Power"
        showLabel={false}
        sources={choices}
        selectedId="peloton"
        onChange={onChange}
        serverUrl="https://api.example.test"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Power source: Peloton" });
    expect(trigger.textContent).toBe("");
    expect(
      trigger.querySelector('[uri="https://api.example.test/logos/peloton.svg"]'),
    ).toBeTruthy();
    fireEvent.click(trigger);
    const selected = screen.getByRole("radio", { name: "Peloton", checked: true });
    expect(selected.textContent).toBe("");
    expect(selected.querySelector('[data-icon="radio-button-on"]')).toBeTruthy();
    const bike = screen.getByRole("radio", {
      name: "Strava · recorded by Peloton Bike",
      checked: false,
    });
    expect(bike.textContent).toBe("Peloton Bike");
    expect(bike.querySelector('[uri="https://api.example.test/logos/strava.svg"]')).toBeTruthy();
    expect(bike.querySelector('[data-icon="radio-button-off"]')).toBeTruthy();
    fireEvent.click(bike);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("strava-bike");
    expect(screen.queryByRole("radio")).toBeNull();
    rerender(
      <ActivityMetricSourcePicker
        label="Power"
        showLabel={false}
        sources={choices}
        selectedId="strava-bike"
        onChange={onChange}
        serverUrl="https://api.example.test"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Power source: Strava · recorded by Peloton Bike" })
        .textContent,
    ).toBe("Peloton Bike");
  });

  it("shows a compact device name while keeping full provenance accessible", () => {
    const source: ActivityMetricSource = {
      id: "edge",
      label: "Garmin Edge 1050 · Recorded by Garmin Edge 1050 · FIT file creator Garmin",
      presentation: {
        displayName: "Garmin Edge 1050",
        providerId: "garmin",
        sourceName: "Edge 1050",
        attribution: null,
      },
    };
    render(
      <ActivityMetricSourcePicker
        label="Power"
        sources={[source]}
        selectedId={source.id}
        onChange={vi.fn()}
        serverUrl=""
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: `Power source: ${source.label}` }));
    expect(screen.getByRole("radio", { name: source.label }).textContent).toBe("Garmin Edge 1050");
  });
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
      sources[0]?.presentation.displayName,
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
    expect(trigger.textContent).toBe("Heart Rate · ");
    fireEvent.click(trigger);
    const option = screen.getByRole("radio", { name: fullLabel });
    expect(option.querySelector(`[data-icon="${icon}"]`)).toBeTruthy();
    expect(option.textContent).toBe("");
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
    ).toBe("Heart Rate · ");
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
