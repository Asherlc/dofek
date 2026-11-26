const WHOOP_UNSUPPORTED_DEVICE_CODE = "NO_SERVICE";

/** Matches the native WHOOP BLE rejection when no supported strap service is present. */
export function isUnsupportedWhoopDevice(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === WHOOP_UNSUPPORTED_DEVICE_CODE
  );
}
