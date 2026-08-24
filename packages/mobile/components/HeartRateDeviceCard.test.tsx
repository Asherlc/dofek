import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HeartRateDeviceCard, type HeartRateDeviceCardProps } from "./HeartRateDeviceCard";

const baseProps: HeartRateDeviceCardProps = {
  connectedDeviceCount: 0,
  onManageDevices: () => {},
};

describe("HeartRateDeviceCard", () => {
  it("explains when no Bluetooth devices are connected", () => {
    render(<HeartRateDeviceCard {...baseProps} />);
    expect(screen.getByText("No Bluetooth devices connected")).toBeTruthy();
  });

  it("summarizes the shared connected device count", () => {
    render(<HeartRateDeviceCard {...baseProps} connectedDeviceCount={2} />);

    expect(screen.getByText("2 Bluetooth devices connected")).toBeTruthy();
  });

  it("opens Bluetooth device management instead of offering a single-device connection", () => {
    const onManageDevices = vi.fn();
    render(<HeartRateDeviceCard onManageDevices={onManageDevices} connectedDeviceCount={2} />);

    fireEvent.click(screen.getByRole("button", { name: "Manage Bluetooth devices" }));

    expect(onManageDevices).toHaveBeenCalledOnce();
  });
});
