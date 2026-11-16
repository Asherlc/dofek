import {
  type ActivityMetricSource,
  activityMetricSourcePresentation,
  activityMetricSourceSchema,
} from "@dofek/providers/activity-metric-source";
import { providerSourceLabel } from "@dofek/providers/providers";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActivityMetricSourcePicker } from "./ActivityMetricSourcePicker";

const whoopBleSourceFor = (deviceId: string) => {
  const providerId = "whoop_ble";
  const label = providerSourceLabel(providerId, deviceId);
  return activityMetricSourceSchema.parse({
    id: JSON.stringify([providerId, deviceId]),
    label,
    presentation: activityMetricSourcePresentation(providerId, deviceId, label),
  });
};
const whoopBleSource = whoopBleSourceFor("A050E4D0-67D0-4F4D-9A43-756F7D343DA1");
const secondWhoopBleSource = whoopBleSourceFor("B160F5E1-78E1-50A5-AB54-86708E454EB2");
const whoopBleSources = [whoopBleSource, secondWhoopBleSource];

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
  ...whoopBleSources,
];

describe("ActivityMetricSourcePicker", () => {
  it("shows WHOOP with a Peloton badge while retaining accessible source and selection", () => {
    const source: ActivityMetricSource = {
      id: "peloton-copy",
      label: "WHOOP via Peloton",
      presentation: {
        displayName: "WHOOP",
        providerId: "whoop",
        sourceName: null,
        attribution: { kind: "provider", providerId: "peloton", label: "Peloton" },
      },
    };
    render(
      <ActivityMetricSourcePicker
        label="Heart Rate"
        sources={[source]}
        selectedId={source.id}
        onChange={() => {}}
        serverUrl="https://api.example.test"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Heart Rate source: WHOOP via Peloton" });
    expect(
      trigger.querySelector('[data-source-uri="https://api.example.test/logos/whoop.png"]'),
    ).toBeTruthy();
    expect(
      trigger.querySelector('[uri="https://api.example.test/logos/peloton.svg"]'),
    ).toBeTruthy();
    fireEvent.click(trigger);
    const option = screen.getByRole("radio", { name: "WHOOP via Peloton", checked: true });
    expect(
      option.querySelector('[data-source-uri="https://api.example.test/logos/whoop.png"]'),
    ).toBeTruthy();
    expect(option.querySelector('[uri="https://api.example.test/logos/peloton.svg"]')).toBeTruthy();
  });
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
    [whoopBleSource.id, "bluetooth-outline", whoopBleSource.label],
  ])("uses the structured attribution icon for %s", (selectedId, icon, fullLabel) => {
    const selectedWhoopBleSource = whoopBleSources.find((source) => source.id === selectedId);
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
    expect(trigger.textContent).toBe(
      selectedWhoopBleSource
        ? `Heart Rate · ${selectedWhoopBleSource.presentation.displayName}`
        : "Heart Rate · ",
    );
    fireEvent.click(trigger);
    const option = screen.getByRole("radio", { name: fullLabel });
    expect(option.querySelector(`[data-icon="${icon}"]`)).toBeTruthy();
    expect(option.textContent).toBe(selectedWhoopBleSource?.presentation.displayName ?? "");
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
      name: whoopBleSource.label,
      checked: false,
    });
    expect(bluetoothChoice.style.minHeight).toBe("44px");
    const secondBluetoothChoice = screen.getByRole("radio", {
      name: secondWhoopBleSource.label,
      checked: false,
    });
    expect(secondBluetoothChoice.textContent).toBe(secondWhoopBleSource.presentation.displayName);
    fireEvent.click(bluetoothChoice);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(whoopBleSource.id);
    expect(screen.queryByRole("radio")).toBeNull();
    rerender(
      <ActivityMetricSourcePicker
        label="Heart Rate"
        sources={sources}
        selectedId={whoopBleSource.id}
        serverUrl=""
        onChange={onChange}
      />,
    );
    expect(
      screen.getByRole("button", { name: `Heart Rate source: ${whoopBleSource.label}` })
        .textContent,
    ).toBe(`Heart Rate · ${whoopBleSource.presentation.displayName}`);

    const selectedBluetoothTrigger = screen.getByRole("button", {
      name: `Heart Rate source: ${whoopBleSource.label}`,
    });
    fireEvent.click(selectedBluetoothTrigger);
    const secondBluetoothOption = screen.getByRole("radio", {
      name: secondWhoopBleSource.label,
      checked: false,
    });
    expect(secondBluetoothOption.textContent).toBe(secondWhoopBleSource.presentation.displayName);
    fireEvent.click(secondBluetoothOption);
    expect(onChange).toHaveBeenLastCalledWith(secondWhoopBleSource.id);
    rerender(
      <ActivityMetricSourcePicker
        label="Heart Rate"
        sources={sources}
        selectedId={secondWhoopBleSource.id}
        serverUrl=""
        onChange={onChange}
      />,
    );
    const secondBluetoothTrigger = screen.getByRole("button", {
      name: `Heart Rate source: ${secondWhoopBleSource.label}`,
    });
    expect(secondBluetoothTrigger.textContent).toContain(
      secondWhoopBleSource.presentation.displayName,
    );
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
