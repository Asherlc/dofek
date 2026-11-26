import type { BluetoothDevice } from "./bluetooth-device-catalog";

/** Inline status for list/detail rows; unsupported WHOOP overrides the machine state label. */
export function bluetoothDeviceStatusLabel(device: BluetoothDevice): string {
  if (device.kind === "whoop" && device.unsupportedDevice) {
    return "Unsupported device";
  }
  return device.connectionState;
}
