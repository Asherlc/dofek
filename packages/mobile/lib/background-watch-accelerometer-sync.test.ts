import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIsWatchPaired = vi.fn(() => true);
const mockIsWatchAppInstalled = vi.fn(() => true);

vi.mock("../modules/watch-motion", () => ({
	isWatchPaired: () => mockIsWatchPaired(),
	isWatchAppInstalled: () => mockIsWatchAppInstalled(),
	getPendingWatchSamples: vi.fn(() => Promise.resolve([])),
	acknowledgeWatchSamples: vi.fn(),
	getLastWatchSyncTimestamp: vi.fn(() => null),
	setLastWatchSyncTimestamp: vi.fn(),
	requestWatchSync: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("./watch-accelerometer-adapter", () => ({
	createWatchCoreMotionAdapter: vi.fn(() => ({
		isAccelerometerRecordingAvailable: () => true,
		queryRecordedData: () => Promise.resolve([]),
		getLastSyncTimestamp: () => null,
		setLastSyncTimestamp: vi.fn(),
		startRecording: () => Promise.resolve(true),
		isRecordingActive: () => true,
	})),
}));

vi.mock("./accelerometer-sync", () => ({
	syncAccelerometerToServer: vi.fn(() =>
		Promise.resolve({ inserted: 0, recording: true }),
	),
}));

import {
	initBackgroundWatchAccelerometerSync,
	teardownBackgroundWatchAccelerometerSync,
} from "./background-watch-accelerometer-sync";

describe("backgroundWatchAccelerometerSync", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsWatchPaired.mockReturnValue(true);
		mockIsWatchAppInstalled.mockReturnValue(true);
		teardownBackgroundWatchAccelerometerSync();
	});

	it("initializes without throwing when Watch is paired", async () => {
		const mockClient = {
			accelerometerSync: {
				pushAccelerometerSamples: {
					mutate: vi.fn(() => Promise.resolve({ inserted: 0 })),
				},
			},
		};

		await expect(
			initBackgroundWatchAccelerometerSync(mockClient),
		).resolves.not.toThrow();
	});

	it("skips initialization when Watch is not paired", async () => {
		mockIsWatchPaired.mockReturnValue(false);

		const mockClient = {
			accelerometerSync: {
				pushAccelerometerSamples: {
					mutate: vi.fn(() => Promise.resolve({ inserted: 0 })),
				},
			},
		};

		await initBackgroundWatchAccelerometerSync(mockClient);
		// Should return early — no error, no crash
	});

	it("skips initialization when Watch app is not installed", async () => {
		mockIsWatchAppInstalled.mockReturnValue(false);

		const mockClient = {
			accelerometerSync: {
				pushAccelerometerSamples: {
					mutate: vi.fn(() => Promise.resolve({ inserted: 0 })),
				},
			},
		};

		await initBackgroundWatchAccelerometerSync(mockClient);
		// Should return early — no error, no crash
	});

	it("tears down without throwing even when not initialized", () => {
		expect(() => teardownBackgroundWatchAccelerometerSync()).not.toThrow();
	});
});
