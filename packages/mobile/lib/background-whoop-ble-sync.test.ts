import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AppState } from "react-native";
import {
	initBackgroundWhoopBleSync,
	teardownBackgroundWhoopBleSync,
	type WhoopBleSyncDeps,
} from "./background-whoop-ble-sync.ts";
import type { AccelerometerUploadClient } from "./accelerometer-service.ts";

function makeMockDeps(): WhoopBleSyncDeps {
	return {
		isBluetoothAvailable: vi.fn().mockReturnValue(true),
		findWhoop: vi.fn().mockResolvedValue({ id: "whoop-123", name: "WHOOP 4.0" }),
		connect: vi.fn().mockResolvedValue(true),
		startImuStreaming: vi.fn().mockResolvedValue(true),
		stopImuStreaming: vi.fn().mockResolvedValue(true),
		getBufferedSamples: vi.fn().mockResolvedValue([]),
		disconnect: vi.fn(),
	};
}

function makeMockTrpcClient(): AccelerometerUploadClient {
	return {
		accelerometerSync: {
			pushAccelerometerSamples: {
				mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
			},
		},
	};
}

let appStateCallback: ((state: string) => void) | null = null;
const mockRemove = vi.fn();

vi.mock("react-native", () => ({
	AppState: {
		addEventListener: vi.fn().mockImplementation((_event: string, callback: (state: string) => void) => {
			appStateCallback = callback;
			return { remove: mockRemove };
		}),
	},
}));

describe("background-whoop-ble-sync", () => {
	let whoopDeps: WhoopBleSyncDeps;
	let trpcClient: AccelerometerUploadClient;

	beforeEach(() => {
		whoopDeps = makeMockDeps();
		trpcClient = makeMockTrpcClient();
		appStateCallback = null;
		mockRemove.mockClear();
		(AppState.addEventListener as ReturnType<typeof vi.fn>).mockClear();
		teardownBackgroundWhoopBleSync();
	});

	afterEach(() => {
		teardownBackgroundWhoopBleSync();
	});

	it("registers an AppState listener on init", async () => {
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

		expect(AppState.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
	});

	it("connects and starts streaming immediately on init", async () => {
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

		expect(whoopDeps.findWhoop).toHaveBeenCalled();
		expect(whoopDeps.connect).toHaveBeenCalledWith("whoop-123");
		expect(whoopDeps.startImuStreaming).toHaveBeenCalled();
	});

	it("uploads buffered samples immediately on init", async () => {
		const samples = [
			{ timestamp: "2026-03-27T10:00:00.000Z", accelerometerX: 1, accelerometerY: 2, accelerometerZ: 3, gyroscopeX: 0, gyroscopeY: 0, gyroscopeZ: 0 },
		];
		(whoopDeps.getBufferedSamples as ReturnType<typeof vi.fn>).mockResolvedValue(samples);

		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

		expect(trpcClient.accelerometerSync.pushAccelerometerSamples.mutate).toHaveBeenCalledWith({
			deviceId: "WHOOP Strap",
			deviceType: "whoop",
			samples: [{ timestamp: "2026-03-27T10:00:00.000Z", x: 1, y: 2, z: 3 }],
		});
	});

	it("connects to WHOOP and starts streaming on first foreground", async () => {
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
		appStateCallback?.("active");

		await vi.waitFor(() => {
			expect(whoopDeps.startImuStreaming).toHaveBeenCalled();
		});
		expect(whoopDeps.findWhoop).toHaveBeenCalled();
		expect(whoopDeps.connect).toHaveBeenCalledWith("whoop-123");
	});

	it("uploads buffered samples on foreground", async () => {
		const samples = [
			{ timestamp: "2026-03-25T08:00:00.000Z", accelerometerX: 100, accelerometerY: -200, accelerometerZ: 300, gyroscopeX: 10, gyroscopeY: -20, gyroscopeZ: 30 },
		];
		(whoopDeps.getBufferedSamples as ReturnType<typeof vi.fn>).mockResolvedValue(samples);

		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
		appStateCallback?.("active");

		await vi.waitFor(() => {
			expect(trpcClient.accelerometerSync.pushAccelerometerSamples.mutate).toHaveBeenCalledWith({
				deviceId: "WHOOP Strap",
				deviceType: "whoop",
				samples: expect.arrayContaining([
					expect.objectContaining({ timestamp: "2026-03-25T08:00:00.000Z" }),
				]),
			});
		});
	});

	it("skips when Bluetooth is unavailable", async () => {
		(whoopDeps.isBluetoothAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false);

		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
		await appStateCallback?.("active");

		expect(whoopDeps.findWhoop).not.toHaveBeenCalled();
	});

	it("skips when WHOOP not found", async () => {
		(whoopDeps.findWhoop as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
		await appStateCallback?.("active");

		expect(whoopDeps.connect).not.toHaveBeenCalled();
	});

	it("does not upload when buffer is empty", async () => {
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
		await appStateCallback?.("active");

		expect(trpcClient.accelerometerSync.pushAccelerometerSamples.mutate).not.toHaveBeenCalled();
	});

	it("ignores non-active state changes", async () => {
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
		// Init does an initial sync, so clear call counts before testing state changes
		(whoopDeps.getBufferedSamples as ReturnType<typeof vi.fn>).mockClear();

		await appStateCallback?.("background");
		await appStateCallback?.("inactive");

		// No additional sync calls from non-active state changes
		expect(whoopDeps.getBufferedSamples).not.toHaveBeenCalled();
	});

	it("prevents concurrent syncs on foreground events", async () => {
		// Let init complete normally first
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

		// Clear counts from the initial sync
		(whoopDeps.getBufferedSamples as ReturnType<typeof vi.fn>).mockClear();

		// Now make getBufferedSamples slow to simulate a long sync
		let resolveBuffered: (() => void) | null = null;
		(whoopDeps.getBufferedSamples as ReturnType<typeof vi.fn>).mockImplementation(
			() => new Promise((resolve) => { resolveBuffered = () => resolve([]); }),
		);

		// First foreground — starts but doesn't resolve
		appStateCallback?.("active");
		// Second foreground — should be skipped because syncing is true
		appStateCallback?.("active");

		// getBufferedSamples should only be called once for the foreground events
		// (the second call was skipped due to the syncing guard)
		expect(whoopDeps.getBufferedSamples).toHaveBeenCalledTimes(1);

		// Resolve so cleanup doesn't hang
		resolveBuffered?.();
	});

	it("teardown removes the AppState listener", async () => {
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

		teardownBackgroundWhoopBleSync();

		expect(mockRemove).toHaveBeenCalled();
	});

	it("teardown stops streaming and disconnects", async () => {
		// Init now connects immediately, no foreground event needed
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

		teardownBackgroundWhoopBleSync();

		expect(whoopDeps.stopImuStreaming).toHaveBeenCalled();
		expect(whoopDeps.disconnect).toHaveBeenCalled();
	});

	it("does not throw when connection fails", async () => {
		(whoopDeps.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("BLE error"));

		// Init should not throw even when BLE connection fails (best-effort)
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

		expect(whoopDeps.connect).toHaveBeenCalled();
	});
});
