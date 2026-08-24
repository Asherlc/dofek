import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BluetoothDeviceCard, type BluetoothDeviceCardProps } from "./BluetoothDeviceCard";

const baseProps: BluetoothDeviceCardProps = {
  connectedDeviceCount: 0,
  error: null,
  loading: false,
  onManageDevices: () => {},
};

describe("BluetoothDeviceCard", () => {
  it("reports device loading separately from an empty completed catalog", () => {
    render(<BluetoothDeviceCard {...baseProps} loading />);

    expect(screen.getByText("Loading Bluetooth devices…")).toBeTruthy();
    expect(screen.queryByText("No Bluetooth devices connected")).toBeNull();
  });

  it("explains when no Bluetooth devices are connected", () => {
    render(<BluetoothDeviceCard {...baseProps} />);
    expect(screen.getByText("No Bluetooth devices connected")).toBeTruthy();
  });

  it("summarizes the shared connected device count", () => {
    render(<BluetoothDeviceCard {...baseProps} connectedDeviceCount={2} />);

    expect(screen.getByText("2 Bluetooth devices connected")).toBeTruthy();
  });

  it("renders the Bluetooth catalog error instead of an empty-device summary", () => {
    render(
      <BluetoothDeviceCard
        {...baseProps}
        error="Bluetooth permission is required to list devices."
      />,
    );

    expect(screen.getByText("Bluetooth permission is required to list devices.")).toBeTruthy();
    expect(screen.queryByText("No Bluetooth devices connected")).toBeNull();
  });

  it("opens Bluetooth device management instead of offering a single-device connection", () => {
    const onManageDevices = vi.fn();
    render(
      <BluetoothDeviceCard
        onManageDevices={onManageDevices}
        connectedDeviceCount={2}
        error={null}
        loading={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Manage Bluetooth devices" }));

    expect(onManageDevices).toHaveBeenCalledOnce();
  });
});
