import type { EventSubscription } from "expo-modules-core";
import BackgroundRefreshModule from "./src/BackgroundRefreshModule";

/** Schedule the next background refresh wakeup.
 * Call this after completing background work so the system
 * knows to wake us again. */
export function scheduleRefresh(): void {
	BackgroundRefreshModule.scheduleRefresh();
}

/** Check if background app refresh is available.
 * Returns false if the user has disabled it in iOS Settings. */
export function isBackgroundRefreshAvailable(): boolean {
	return BackgroundRefreshModule.isAvailable();
}

/** Listen for background refresh wakeups.
 * The callback fires when iOS wakes the app via BGAppRefreshTask
 * (~every 15-30 minutes). Use it to restart Watch recording,
 * reconnect WHOOP BLE, and sync buffered data. */
export function addBackgroundRefreshListener(
	callback: () => void,
): EventSubscription {
	return BackgroundRefreshModule.addListener("onBackgroundRefresh", callback);
}
