import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AppState } from "react-native";
import {
	initBackgroundWhoopBleSync,
	teardownBackgroundWhoopBleSync,
	syncWhoopBle,
	type WhoopBleSyncDeps,
} from "./background-whoop-ble-sync.ts";
import type { AccelerometerUploadClient } from "./accelerometer-service.ts";
import * as telemetry from "./telemetry";

vi.mock("./telemetry", () => ({
	captureException: vi.fn(),
}));

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
		await appStateCallback?.("background");
		await appStateCallback?.("inactive");

		expect(whoopDeps.findWhoop).not.toHaveBeenCalled();
	});

	it("prevents concurrent syncs", async () => {
		// Make findWhoop slow
		let resolveFind: ((value: { id: string; name: string }) => void) | null = null;
		(whoopDeps.findWhoop as ReturnType<typeof vi.fn>).mockImplementation(
			() => new Promise((resolve) => { resolveFind = resolve; }),
		);

		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

		// First foreground — starts but doesn't resolve
		const firstSync = appStateCallback?.("active");
		// Second foreground — should be skipped
		await appStateCallback?.("active");

		// findWhoop should only be called once (second was skipped)
		expect(whoopDeps.findWhoop).toHaveBeenCalledTimes(1);

		// Resolve the first one
		resolveFind?.({ id: "whoop-123", name: "WHOOP 4.0" });
		await firstSync;
	});

	it("teardown removes the AppState listener", async () => {
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

		teardownBackgroundWhoopBleSync();

		expect(mockRemove).toHaveBeenCalled();
	});

	it("teardown stops streaming and disconnects", async () => {
		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
		// Simulate a foreground to establish connection
		appStateCallback?.("active");

		// Wait for the async foreground sync to finish connecting
		await vi.waitFor(() => {
			expect(whoopDeps.startImuStreaming).toHaveBeenCalled();
		});

		teardownBackgroundWhoopBleSync();

		expect(whoopDeps.stopImuStreaming).toHaveBeenCalled();
		expect(whoopDeps.disconnect).toHaveBeenCalled();
	});

	it("does not throw when connection fails", async () => {
		(whoopDeps.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("BLE error"));

		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
		appStateCallback?.("active");

		// Wait for the async sync to complete
		await vi.waitFor(() => {
			expect(whoopDeps.connect).toHaveBeenCalled();
		});
		// No throw — best-effort
	});

	it("reports errors to telemetry when connection fails", async () => {
		const bleError = new Error("BLE error");
		(whoopDeps.connect as ReturnType<typeof vi.fn>).mockRejectedValue(bleError);

		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
		appStateCallback?.("active");

		await vi.waitFor(() => {
			expect(telemetry.captureException).toHaveBeenCalledWith(
				bleError,
				expect.objectContaining({ context: "whoop-ble-sync" }),
			);
		});
	});

	it("reports errors to telemetry when upload fails", async () => {
		const uploadError = new Error("Upload failed");
		const samples = [
			{ timestamp: "2026-03-25T08:00:00.000Z", accelerometerX: 100, accelerometerY: -200, accelerometerZ: 300, gyroscopeX: 10, gyroscopeY: -20, gyroscopeZ: 30 },
		];
		(whoopDeps.getBufferedSamples as ReturnType<typeof vi.fn>).mockResolvedValue(samples);
		(trpcClient.accelerometerSync.pushAccelerometerSamples.mutate as ReturnType<typeof vi.fn>).mockRejectedValue(uploadError);

		await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
		appStateCallback?.("active");

		await vi.waitFor(() => {
			expect(telemetry.captureException).toHaveBeenCalledWith(
				uploadError,
				expect.objectContaining({ context: "whoop-ble-sync" }),
			);
		});
	});
});

describe("syncWhoopBle", () => {
	let whoopDeps: WhoopBleSyncDeps;
	let trpcClient: AccelerometerUploadClient;

	beforeEach(() => {
		teardownBackgroundWhoopBleSync();
		whoopDeps = makeMockDeps();
		trpcClient = makeMockTrpcClient();
		(telemetry.captureException as ReturnType<typeof vi.fn>).mockClear();
	});

	afterEach(() => {
		teardownBackgroundWhoopBleSync();
	});

	it("connects and uploads buffered samples", async () => {
		const samples = [
			{ timestamp: "2026-03-25T08:00:00.000Z", accelerometerX: 100, accelerometerY: -200, accelerometerZ: 300, gyroscopeX: 10, gyroscopeY: -20, gyroscopeZ: 30 },
		];
		(whoopDeps.getBufferedSamples as ReturnType<typeof vi.fn>).mockResolvedValue(samples);

		await syncWhoopBle(trpcClient, whoopDeps);

		expect(whoopDeps.findWhoop).toHaveBeenCalled();
		expect(whoopDeps.connect).toHaveBeenCalledWith("whoop-123");
		expect(whoopDeps.startImuStreaming).toHaveBeenCalled();
		expect(trpcClient.accelerometerSync.pushAccelerometerSamples.mutate).toHaveBeenCalledWith({
			deviceId: "WHOOP Strap",
			deviceType: "whoop",
			samples: expect.arrayContaining([
				expect.objectContaining({ timestamp: "2026-03-25T08:00:00.000Z" }),
			]),
		});
	});

	it("skips when Bluetooth unavailable", async () => {
		(whoopDeps.isBluetoothAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false);

		await syncWhoopBle(trpcClient, whoopDeps);

		expect(whoopDeps.findWhoop).not.toHaveBeenCalled();
	});

	it("skips when WHOOP not found", async () => {
		(whoopDeps.findWhoop as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		await syncWhoopBle(trpcClient, whoopDeps);

		expect(whoopDeps.connect).not.toHaveBeenCalled();
	});

	it("reports errors to telemetry", async () => {
		const bleError = new Error("BLE error");
		(whoopDeps.connect as ReturnType<typeof vi.fn>).mockRejectedValue(bleError);

		await syncWhoopBle(trpcClient, whoopDeps);

		await vi.waitFor(() => {
			expect(telemetry.captureException).toHaveBeenCalledWith(
				bleError,
				expect.objectContaining({ context: "whoop-ble-sync" }),
			);
		});
	});

	it("does not throw on errors", async () => {
		(whoopDeps.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("BLE error"));

		// Should not throw
		await syncWhoopBle(trpcClient, whoopDeps);
	});
});
