import WhoopBleModule from "./src/WhoopBleModule";

/** A discovered WHOOP strap */
export interface WhoopDevice {
	id: string;
	name: string | null;
}

/** A single IMU sample from the WHOOP strap's accelerometer + gyroscope */
export interface WhoopImuSample {
	timestamp: string; // ISO 8601
	accelerometerX: number; // raw i16
	accelerometerY: number;
	accelerometerZ: number;
	gyroscopeX: number; // raw i16
	gyroscopeY: number;
	gyroscopeZ: number;
}

/** Check whether Bluetooth is powered on and available. */
export function isBluetoothAvailable(): boolean {
	return WhoopBleModule.isBluetoothAvailable();
}

/**
 * Find an already-connected WHOOP strap.
 *
 * First checks `retrieveConnectedPeripherals` (instant) for straps already
 * connected by the WHOOP app. Falls back to a 5-second BLE scan.
 *
 * @returns The discovered WHOOP device, or null if not found.
 */
export async function findWhoop(): Promise<WhoopDevice | null> {
	return WhoopBleModule.findWhoop();
}

/**
 * Connect to a WHOOP strap by its peripheral ID.
 *
 * On iOS, multiple apps can connect to the same BLE peripheral.
 * The WHOOP app stays connected — we establish our own logical connection.
 *
 * @param peripheralId — UUID string from `findWhoop()`.
 * @returns true on success.
 */
export async function connect(peripheralId: string): Promise<boolean> {
	return WhoopBleModule.connect(peripheralId);
}

/**
 * Start real-time IMU streaming from the connected WHOOP strap.
 *
 * Sends the TOGGLE_IMU_MODE (0x6A) BLE command to the strap.
 * IMU samples (accelerometer + gyroscope) are buffered internally.
 * Call `getBufferedSamples()` to retrieve them.
 *
 * @returns true on success.
 */
export async function startImuStreaming(): Promise<boolean> {
	return WhoopBleModule.startImuStreaming();
}

/**
 * Stop IMU streaming and return the strap to normal mode.
 *
 * Sends the STOP_RAW_DATA (0x52) BLE command.
 */
export async function stopImuStreaming(): Promise<boolean> {
	return WhoopBleModule.stopImuStreaming();
}

/**
 * Retrieve and clear the internal IMU sample buffer.
 *
 * Returns all samples accumulated since the last call (or since
 * streaming started). The buffer is cleared after retrieval.
 */
export async function getBufferedSamples(): Promise<WhoopImuSample[]> {
	return WhoopBleModule.getBufferedSamples();
}

/** Disconnect from the WHOOP strap. */
export function disconnect(): void {
	WhoopBleModule.disconnect();
}
