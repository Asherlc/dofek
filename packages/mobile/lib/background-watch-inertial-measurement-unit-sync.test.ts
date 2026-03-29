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

vi.mock("./watch-inertial-measurement-unit-adapter", () => ({
	createWatchInertialMeasurementUnitAdapter: vi.fn(() => ({
		isAccelerometerRecordingAvailable: () => true,
		queryRecordedData: () => Promise.resolve([]),
		getLastSyncTimestamp: () => null,
		setLastSyncTimestamp: vi.fn(),
		startRecording: () => Promise.resolve(true),
		isRecordingActive: () => true,
	})),
}));

vi.mock("./inertial-measurement-unit-sync", () => ({
	syncInertialMeasurementUnitToServer: vi.fn(() =>
		Promise.resolve({ inserted: 0, recording: true }),
	),
}));

import {
	initBackgroundWatchInertialMeasurementUnitSync,
	teardownBackgroundWatchInertialMeasurementUnitSync,
} from "./background-watch-inertial-measurement-unit-sync";

describe("backgroundWatchInertialMeasurementUnitSync", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsWatchPaired.mockReturnValue(true);
		mockIsWatchAppInstalled.mockReturnValue(true);
		teardownBackgroundWatchInertialMeasurementUnitSync();
	});

	it("initializes without throwing when Watch is paired", async () => {
		const mockClient = {
			inertialMeasurementUnitSync: {
				pushSamples: {
					mutate: vi.fn(() => Promise.resolve({ inserted: 0 })),
				},
			},
		};

		await expect(
			initBackgroundWatchInertialMeasurementUnitSync(mockClient),
		).resolves.not.toThrow();
	});

	it("skips initialization when Watch is not paired", async () => {
		mockIsWatchPaired.mockReturnValue(false);

		const mockClient = {
			inertialMeasurementUnitSync: {
				pushSamples: {
					mutate: vi.fn(() => Promise.resolve({ inserted: 0 })),
				},
			},
		};

		await initBackgroundWatchInertialMeasurementUnitSync(mockClient);
	});

	it("skips initialization when Watch app is not installed", async () => {
		mockIsWatchAppInstalled.mockReturnValue(false);

		const mockClient = {
			inertialMeasurementUnitSync: {
				pushSamples: {
					mutate: vi.fn(() => Promise.resolve({ inserted: 0 })),
				},
			},
		};

		await initBackgroundWatchInertialMeasurementUnitSync(mockClient);
	});

	it("tears down without throwing even when not initialized", () => {
		expect(() => teardownBackgroundWatchInertialMeasurementUnitSync()).not.toThrow();
	});
});
