import type { AccelerometerSample } from "../modules/core-motion";

const TWELVE_HOURS_SECONDS = 12 * 3600;
const UPLOAD_BATCH_SIZE = 5000;

/** Abstraction over CoreMotion native module for activity recording */
export interface CoreMotionDeps {
	isAccelerometerRecordingAvailable(): boolean;
	startRecording(durationSeconds: number): Promise<boolean>;
	queryRecordedData(
		fromDate: string,
		toDate: string,
	): Promise<AccelerometerSample[]>;
}

/** Abstraction over Watch motion module for activity recording */
export interface WatchDeps {
	isAvailable(): boolean;
	requestSync(): Promise<boolean>;
	getPendingSamples(): Promise<AccelerometerSample[]>;
	acknowledgeSamples(): void;
}

/** Abstraction over WHOOP BLE module for IMU streaming during activity recording */
export interface WhoopBleDeps {
	isAvailable(): boolean;
	findAndConnect(): Promise<boolean>;
	startStreaming(): Promise<boolean>;
	stopStreaming(): Promise<boolean>;
	getBufferedSamples(): Promise<
		Array<{ timestamp: string; x: number; y: number; z: number }>
	>;
}

/** tRPC client interface for accelerometer upload */
export interface AccelerometerUploadClient {
	accelerometerSync: {
		pushAccelerometerSamples: {
			mutate(input: {
				deviceId: string;
				deviceType: string;
				samples: AccelerometerSample[];
			}): Promise<{ inserted: number }>;
		};
	};
}

export interface AccelerometerServiceDeps {
	coreMotion: CoreMotionDeps;
	watch: WatchDeps;
	whoopBle?: WhoopBleDeps;
	trpcClient: AccelerometerUploadClient;
	deviceId: string;
}

/** Service for managing accelerometer recording during activity recording */
export interface AccelerometerService {
	/** Ensure phone + watch accelerometer recording is active */
	ensureRecording(): Promise<void>;
	/** Sync accelerometer data for a specific time range (after activity save) */
	syncForTimeRange(startedAt: string, endedAt: string): Promise<void>;
}

/**
 * Create an accelerometer service that manages phone + watch accelerometer
 * recording during activity recording.
 *
 * - `ensureRecording()` starts a CoreMotion session and requests Watch sync
 * - `syncForTimeRange()` queries and uploads accelerometer data for the activity window
 *
 * All operations are best-effort — errors are caught to avoid disrupting
 * the GPS recording or activity save.
 */
export function createAccelerometerService(
	deps: AccelerometerServiceDeps,
): AccelerometerService {
	const { coreMotion, watch, whoopBle, trpcClient, deviceId } = deps;

	async function uploadBatched(
		uploadDeviceId: string,
		deviceType: string,
		samples: AccelerometerSample[],
	): Promise<void> {
		for (
			let offset = 0;
			offset < samples.length;
			offset += UPLOAD_BATCH_SIZE
		) {
			const batch = samples.slice(offset, offset + UPLOAD_BATCH_SIZE);
			await trpcClient.accelerometerSync.pushAccelerometerSamples.mutate({
				deviceId: uploadDeviceId,
				deviceType,
				samples: batch,
			});
		}
	}

	return {
		async ensureRecording(): Promise<void> {
			// Start phone accelerometer (best-effort)
			if (coreMotion.isAccelerometerRecordingAvailable()) {
				try {
					await coreMotion.startRecording(TWELVE_HOURS_SECONDS);
				} catch {
					// Best-effort — don't block activity recording
				}
			}

			// Request Watch data transfer (best-effort)
			if (watch.isAvailable()) {
				try {
					await watch.requestSync();
				} catch {
					// Best-effort — Watch may not be reachable
				}
			}

			// Connect to WHOOP strap and start IMU streaming (best-effort)
			if (whoopBle?.isAvailable()) {
				try {
					const connected = await whoopBle.findAndConnect();
					if (connected) {
						await whoopBle.startStreaming();
					}
				} catch {
					// Best-effort — WHOOP may not be nearby or BLE unavailable
				}
			}
		},

		async syncForTimeRange(
			startedAt: string,
			endedAt: string,
		): Promise<void> {
			// Sync phone accelerometer data for the activity window
			if (coreMotion.isAccelerometerRecordingAvailable()) {
				try {
					const phoneSamples = await coreMotion.queryRecordedData(
						startedAt,
						endedAt,
					);
					if (phoneSamples.length > 0) {
						await uploadBatched(deviceId, "iphone", phoneSamples);
					}
				} catch {
					// Best-effort — don't fail activity save
				}
			}

			// Sync Watch accelerometer data
			if (watch.isAvailable()) {
				try {
					const watchSamples = await watch.getPendingSamples();
					if (watchSamples.length > 0) {
						await uploadBatched("Apple Watch", "apple_watch", watchSamples);
						watch.acknowledgeSamples();
					}
				} catch {
					// Best-effort — don't fail activity save
				}
			}

			// Retrieve and upload WHOOP BLE IMU samples
			if (whoopBle?.isAvailable()) {
				try {
					const whoopSamples = await whoopBle.getBufferedSamples();
					if (whoopSamples.length > 0) {
						await uploadBatched(
							"WHOOP Strap",
							"whoop",
							whoopSamples,
						);
					}
					await whoopBle.stopStreaming();
				} catch {
					// Best-effort — don't fail activity save
				}
			}
		},
	};
}
