import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HeartRateDeviceCard, type HeartRateDeviceCardProps } from "./HeartRateDeviceCard";

const baseProps: HeartRateDeviceCardProps = {
  bluetoothAvailable: true,
  connectionState: "disconnected",
  onConnect: () => {},
  onDisconnect: () => {},
};

describe("HeartRateDeviceCard", () => {
  it("shows a connect action when disconnected", () => {
    render(<HeartRateDeviceCard {...baseProps} />);
    expect(screen.getByText("Connect Monitor")).toBeTruthy();
  });

  it("shows a searching state while connecting", () => {
    render(<HeartRateDeviceCard {...baseProps} connectionState="connecting" />);
    expect(screen.getByText("Searching for a heart-rate monitor…")).toBeTruthy();
  });

  it("shows the live reading and device name when connected", () => {
    render(
      <HeartRateDeviceCard
        {...baseProps}
        connectionState="connected"
        deviceName="Polar H10"
        liveBpm={142}
      />,
    );
    expect(screen.getByText("142")).toBeTruthy();
    expect(screen.getByText("bpm")).toBeTruthy();
    expect(screen.getByText("Polar H10")).toBeTruthy();
    expect(screen.getByText("Disconnect")).toBeTruthy();
  });

  it("shows a placeholder before the first reading arrives", () => {
    render(
      <HeartRateDeviceCard {...baseProps} connectionState="connected" deviceName="Polar H10" />,
    );
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("falls back to 'Connected' when the device has no name", () => {
    render(<HeartRateDeviceCard {...baseProps} connectionState="connected" liveBpm={80} />);
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("prompts to enable Bluetooth when it is unavailable", () => {
    render(<HeartRateDeviceCard {...baseProps} bluetoothAvailable={false} />);
    expect(screen.getByText("Turn on Bluetooth to connect a heart-rate monitor.")).toBeTruthy();
  });

  it("invokes onConnect when the connect button is pressed", () => {
    const onConnect = vi.fn();
    render(<HeartRateDeviceCard {...baseProps} onConnect={onConnect} />);

    fireEvent.click(screen.getByText("Connect Monitor"));

    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("invokes onDisconnect when the disconnect button is pressed", () => {
    const onDisconnect = vi.fn();
    render(
      <HeartRateDeviceCard
        {...baseProps}
        connectionState="connected"
        deviceName="Polar H10"
        liveBpm={142}
        onDisconnect={onDisconnect}
      />,
    );

    fireEvent.click(screen.getByText("Disconnect"));

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});
