import CoreMotion
import ExpoModulesCore

// CMSensorDataList conforms to NSFastEnumeration but not Swift's Sequence,
// so we add conformance to enable for-in loops.
extension CMSensorDataList: @retroactive Sequence {
    public func makeIterator() -> NSFastEnumerationIterator {
        return NSFastEnumerationIterator(self)
    }
}

private let lastSyncKey = "com.dofek.coreMotion.lastSyncTimestamp"
private let recordingActiveKey = "com.dofek.coreMotion.recordingActive"

public class CoreMotionModule: Module {
    private let sensorRecorder = CMSensorRecorder()
    private let activityManager = CMMotionActivityManager()

    // swiftlint:disable:next function_body_length
    public func definition() -> ModuleDefinition {
        Name("CoreMotion")

        // MARK: - Availability & permissions

        Function("isAccelerometerRecordingAvailable") {
            return CMSensorRecorder.isAccelerometerRecordingAvailable()
        }

        Function("getMotionAuthorizationStatus") { () -> String in
            let status = CMMotionActivityManager.authorizationStatus()
            switch status {
            case .authorized: return "authorized"
            case .denied: return "denied"
            case .restricted: return "restricted"
            case .notDetermined: return "notDetermined"
            @unknown default: return "notDetermined"
            }
        }

        AsyncFunction("requestMotionPermission") { (promise: Promise) in
            // Querying activity data triggers the permission prompt
            self.activityManager.queryActivityStarting(
                from: Date().addingTimeInterval(-60),
                to: Date(),
                to: OperationQueue.main
            ) { _, error in
                if let error = error {
                    let nsError = error as NSError
                    if nsError.domain == CMErrorDomain && nsError.code == Int(CMErrorMotionActivityNotAuthorized.rawValue) {
                        promise.resolve("denied")
                    } else {
                        promise.resolve("authorized")
                    }
                } else {
                    promise.resolve("authorized")
                }
            }
        }

        // MARK: - Recording

        AsyncFunction("startRecording") { (durationSeconds: Double, promise: Promise) in
            guard CMSensorRecorder.isAccelerometerRecordingAvailable() else {
                promise.reject("COREMOTION_UNAVAILABLE", "Accelerometer recording is not available on this device")
                return
            }

            // CMSensorRecorder.recordAccelerometer runs asynchronously and records
            // even when the app is suspended. Max duration is 12 hours.
            let clampedDuration = min(durationSeconds, 12 * 3600)
            self.sensorRecorder.recordAccelerometer(forDuration: clampedDuration)

            UserDefaults.standard.set(true, forKey: recordingActiveKey)
            promise.resolve(true)
        }

        Function("isRecordingActive") {
            return UserDefaults.standard.bool(forKey: recordingActiveKey)
        }

        // MARK: - Querying recorded data

        /// Query recorded accelerometer samples between two ISO 8601 dates.
        /// Returns an array of {timestamp, x, y, z} objects.
        /// CMSensorRecorder retains up to 3 days of data.
        AsyncFunction("queryRecordedData") { (fromDateString: String, toDateString: String, promise: Promise) in
            guard CMSensorRecorder.isAccelerometerRecordingAvailable() else {
                promise.resolve([])
                return
            }

            guard let fromDate = ISO8601DateFormatter().date(from: fromDateString),
                  let toDate = ISO8601DateFormatter().date(from: toDateString) else {
                promise.reject("COREMOTION_INVALID_DATE", "Invalid ISO 8601 date string")
                return
            }

            // Query must happen on a background thread — iterating CMSensorDataList
            // can take seconds for large time ranges
            DispatchQueue.global(qos: .userInitiated).async {
                guard let dataList = self.sensorRecorder.accelerometerData(from: fromDate, to: toDate) else {
                    DispatchQueue.main.async {
                        promise.resolve([])
                    }
                    return
                }

                var samples: [[String: Any]] = []
                samples.reserveCapacity(50 * 60 * 10) // ~10 minutes at 50 Hz

                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

                for dataPoint in dataList {
                    guard let accelerometerData = dataPoint as? CMRecordedAccelerometerData else {
                        continue
                    }

                    samples.append([
                        "timestamp": formatter.string(from: accelerometerData.startDate),
                        "x": accelerometerData.acceleration.x,
                        "y": accelerometerData.acceleration.y,
                        "z": accelerometerData.acceleration.z,
                    ])
                }

                DispatchQueue.main.async {
                    promise.resolve(samples)
                }
            }
        }

        // MARK: - Sync cursor persistence

        Function("getLastSyncTimestamp") { () -> String? in
            return UserDefaults.standard.string(forKey: lastSyncKey)
        }

        Function("setLastSyncTimestamp") { (timestamp: String) in
            UserDefaults.standard.set(timestamp, forKey: lastSyncKey)
        }
    }
}
