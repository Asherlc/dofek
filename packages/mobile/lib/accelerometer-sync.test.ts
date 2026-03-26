import { describe, expect, it, vi } from "vitest";
import type { AccelerometerSample } from "../modules/core-motion";
import {
	syncAccelerometerToServer,
	type AccelerometerSyncTrpcClient,
	type CoreMotionAdapter,
} from "./accelerometer-sync";

function makeCoreMotion(
	overrides: Partial<CoreMotionAdapter> = {},
): CoreMotionAdapter {
	return {
		isAccelerometerRecordingAvailable: () => true,
		queryRecordedData: vi.fn().mockResolvedValue([]),
		getLastSyncTimestamp: () => null,
		setLastSyncTimestamp: vi.fn(),
		startRecording: vi.fn().mockResolvedValue(true),
		isRecordingActive: () => false,
		...overrides,
	};
}

function makeTrpcClient(
	overrides: Partial<{
		pushResult: { inserted: number };
	}> = {},
): AccelerometerSyncTrpcClient {
	return {
		accelerometerSync: {
			pushAccelerometerSamples: {
				mutate: vi
					.fn()
					.mockResolvedValue(overrides.pushResult ?? { inserted: 0 }),
			},
		},
	};
}

function makeSamples(count: number): AccelerometerSample[] {
	return Array.from({ length: count }, (_, index) => ({
		timestamp: new Date(Date.now() - (count - index) * 20).toISOString(),
		x: Math.random() * 2 - 1,
		y: Math.random() * 2 - 1,
		z: Math.random() * 2 - 1,
	}));
}

describe("syncAccelerometerToServer", () => {
	it("returns zero when accelerometer is not available", async () => {
		const coreMotion = makeCoreMotion({
			isAccelerometerRecordingAvailable: () => false,
		});
		const trpcClient = makeTrpcClient();

		const result = await syncAccelerometerToServer({
			trpcClient,
			coreMotion,
			deviceId: "iPhone 15 Pro",
			deviceType: "iphone",
		});

		expect(result.inserted).toBe(0);
		expect(result.recording).toBe(false);
	});

	it("queries from lastSyncTimestamp when available", async () => {
		const queryRecordedData = vi.fn().mockResolvedValue([]);
		const lastSync = new Date(Date.now() - 60_000).toISOString();
		const coreMotion = makeCoreMotion({
			getLastSyncTimestamp: () => lastSync,
			queryRecordedData,
		});
		const trpcClient = makeTrpcClient();

		await syncAccelerometerToServer({
			trpcClient,
			coreMotion,
			deviceId: "iPhone 15 Pro",
			deviceType: "iphone",
		});

		expect(queryRecordedData).toHaveBeenCalledTimes(1);
		const [fromDate] = queryRecordedData.mock.calls[0];
		expect(fromDate).toBe(lastSync);
	});

	it("uploads samples in batches of 5000", async () => {
		const samples = makeSamples(7500);
		const coreMotion = makeCoreMotion({
			queryRecordedData: vi.fn().mockResolvedValue(samples),
		});
		const trpcClient = makeTrpcClient({ pushResult: { inserted: 5000 } });

		const result = await syncAccelerometerToServer({
			trpcClient,
			coreMotion,
			deviceId: "iPhone 15 Pro",
			deviceType: "iphone",
		});

		const mutate =
			trpcClient.accelerometerSync.pushAccelerometerSamples.mutate;
		expect(mutate).toHaveBeenCalledTimes(2);

		// First batch: 5000 samples
		const firstCall = (mutate as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(firstCall.samples).toHaveLength(5000);
		expect(firstCall.deviceId).toBe("iPhone 15 Pro");
		expect(firstCall.deviceType).toBe("iphone");

		// Second batch: 2500 samples
		const secondCall = (mutate as ReturnType<typeof vi.fn>).mock.calls[1][0];
		expect(secondCall.samples).toHaveLength(2500);
	});

	it("advances sync cursor only after all batches succeed", async () => {
		const samples = makeSamples(100);
		const setLastSyncTimestamp = vi.fn();
		const coreMotion = makeCoreMotion({
			queryRecordedData: vi.fn().mockResolvedValue(samples),
			setLastSyncTimestamp,
		});
		const trpcClient = makeTrpcClient({ pushResult: { inserted: 100 } });

		await syncAccelerometerToServer({
			trpcClient,
			coreMotion,
			deviceId: "iPhone 15 Pro",
			deviceType: "iphone",
		});

		expect(setLastSyncTimestamp).toHaveBeenCalledTimes(1);
		// Should be called with a recent timestamp (within last second)
		const savedTimestamp = new Date(
			setLastSyncTimestamp.mock.calls[0][0],
		).getTime();
		expect(savedTimestamp).toBeGreaterThan(Date.now() - 2000);
	});

	it("does not advance cursor when upload fails", async () => {
		const samples = makeSamples(100);
		const setLastSyncTimestamp = vi.fn();
		const coreMotion = makeCoreMotion({
			queryRecordedData: vi.fn().mockResolvedValue(samples),
			setLastSyncTimestamp,
		});
		const trpcClient = makeTrpcClient();
		(
			trpcClient.accelerometerSync.pushAccelerometerSamples
				.mutate as ReturnType<typeof vi.fn>
		).mockRejectedValue(new Error("Network error"));

		await expect(
			syncAccelerometerToServer({
				trpcClient,
				coreMotion,
				deviceId: "iPhone 15 Pro",
				deviceType: "iphone",
			}),
		).rejects.toThrow("Network error");

		expect(setLastSyncTimestamp).not.toHaveBeenCalled();
	});

	it("restarts recording after sync", async () => {
		const startRecording = vi.fn().mockResolvedValue(true);
		const coreMotion = makeCoreMotion({ startRecording });
		const trpcClient = makeTrpcClient();

		await syncAccelerometerToServer({
			trpcClient,
			coreMotion,
			deviceId: "iPhone 15 Pro",
			deviceType: "iphone",
		});

		expect(startRecording).toHaveBeenCalledWith(43200); // 12 hours
	});

	it("handles empty data gracefully", async () => {
		const setLastSyncTimestamp = vi.fn();
		const coreMotion = makeCoreMotion({
			queryRecordedData: vi.fn().mockResolvedValue([]),
			setLastSyncTimestamp,
		});
		const trpcClient = makeTrpcClient();

		const result = await syncAccelerometerToServer({
			trpcClient,
			coreMotion,
			deviceId: "iPhone 15 Pro",
			deviceType: "iphone",
		});

		expect(result.inserted).toBe(0);
		// Should still advance cursor (no data to sync = up to date)
		expect(setLastSyncTimestamp).toHaveBeenCalledTimes(1);
		// Should not call push mutation
		expect(
			trpcClient.accelerometerSync.pushAccelerometerSamples.mutate,
		).not.toHaveBeenCalled();
	});
});
