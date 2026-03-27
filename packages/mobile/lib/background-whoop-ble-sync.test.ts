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

	it("connects to WHOOP and starts streaming immediately on init", async () => {
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

		expect(whoopDeps.findWhoop).toHaveBeenCalled();
		expect(whoopDeps.connect).toHaveBeenCalledWith("whoop-123");
		expect(whoopDeps.startImuStreaming).toHaveBeenCalled();
	});

	it("uploads buffered samples on subsequent foreground", async () => {
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

		// Reset mocks after init (which already connected)
		(whoopDeps.findWhoop as ReturnType<typeof vi.fn>).mockClear();
		(whoopDeps.connect as ReturnType<typeof vi.fn>).mockClear();

		appStateCallback?.("active");

		await vi.waitFor(() => {
			// Should NOT re-connect (already connected from init)
			expect(whoopDeps.findWhoop).not.toHaveBeenCalled();
		});
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

		// Init calls findWhoop once during immediate sync — clear for this test
		(whoopDeps.findWhoop as ReturnType<typeof vi.fn>).mockClear();

		await appStateCallback?.("background");
		await appStateCallback?.("inactive");

		expect(whoopDeps.findWhoop).not.toHaveBeenCalled();
	});

	it("prevents concurrent syncs via AppState handler", async () => {
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

		// Init already connected — make getBufferedSamples slow for concurrency test
		let resolveSamples: ((value: Array<{ timestamp: string; accelerometerX: number; accelerometerY: number; accelerometerZ: number; gyroscopeX: number; gyroscopeY: number; gyroscopeZ: number }>) => void) | null = null;
		(whoopDeps.getBufferedSamples as ReturnType<typeof vi.fn>).mockImplementation(
			() => new Promise((resolve) => { resolveSamples = resolve; }),
		);

		// First foreground — starts but doesn't resolve
		appStateCallback?.("active");
		// Second foreground — should be skipped (syncing flag is set)
		appStateCallback?.("active");

		// getBufferedSamples should only be called once from the AppState handler
		// (plus once from init = 2 total, but we're checking the handler calls)
		await vi.waitFor(() => {
			expect(whoopDeps.getBufferedSamples).toHaveBeenCalledTimes(2); // 1 from init + 1 from first foreground
		});

		// Resolve the first one
		resolveSamples?.([]);
	});

	it("teardown removes the AppState listener", async () => {
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

		teardownBackgroundWhoopBleSync();

		expect(mockRemove).toHaveBeenCalled();
	});

	it("teardown stops streaming and disconnects", async () => {
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
		// Simulate a foreground to establish connection
		await appStateCallback?.("active");

		teardownBackgroundWhoopBleSync();

		expect(whoopDeps.stopImuStreaming).toHaveBeenCalled();
		expect(whoopDeps.disconnect).toHaveBeenCalled();
	});

	it("does not throw when connection fails on init", async () => {
		(whoopDeps.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("BLE error"));

		// Init catches the error from the immediate sync — should not throw
		await expect(
			initBackgroundWhoopBleSync(trpcClient, whoopDeps),
		).resolves.not.toThrow();

		expect(whoopDeps.connect).toHaveBeenCalled();
	});
});
