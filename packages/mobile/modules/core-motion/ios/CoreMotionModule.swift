import Foundation

#if os(iOS) && canImport(ExpoModulesCore)
import CoreMotion
import ExpoModulesCore
#endif

enum CoreMotionIsoDateParser {
    private static let fractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let internetDateTime: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func parse(_ value: String) -> Date? {
        if let date = fractionalSeconds.date(from: value) {
            return date
        }

        return internetDateTime.date(from: value)
    }

    static func format(_ value: Date) -> String {
        return fractionalSeconds.string(from: value)
    }
}

#if os(iOS) && canImport(ExpoModulesCore)
// CMSensorDataList conforms to NSFastEnumeration but not Swift's Sequence,
// so we add conformance to enable for-in loops.
extension CMSensorDataList: @retroactive Sequence {
    public func makeIterator() -> NSFastEnumerationIterator {
        return NSFastEnumerationIterator(self)
    }
}

public class CoreMotionModule: Module {
    private let sensorRecorder = CMSensorRecorder()
    private let activityManager = CMMotionActivityManager()
    private let accountStateStore = CoreMotionAccountStateStore(userDefaults: .standard)

    public func definition() -> ModuleDefinition {
        Name("CoreMotion")

        // MARK: - Availability & permissions

        Function("isAccelerometerRecordingAvailable") {
            return CMSensorRecorder.isAccelerometerRecordingAvailable()
        }

        Function("getMotionAuthorizationStatus") { () -> String in
            self.motionAuthorizationStatus()
        }

        AsyncFunction("requestMotionPermission") { (promise: Promise) in
            self.requestMotionPermission(promise: promise)
        }

        // MARK: - Recording

        AsyncFunction("startRecording") { (durationSeconds: Double, promise: Promise) in
            self.startRecording(durationSeconds: durationSeconds, promise: promise)
        }

        Function("isRecordingActive") {
            return UserDefaults.standard.bool(
                forKey: CoreMotionAccountStateStore.recordingActiveKey
            )
        }

        // MARK: - Querying recorded data

        /// Query recorded accelerometer samples between two ISO 8601 dates.
        /// Returns an array of {timestamp, x, y, z} objects.
        /// CMSensorRecorder retains up to 3 days of data.
        AsyncFunction("queryRecordedData") { (fromDateString: String, toDateString: String, promise: Promise) in
            self.queryRecordedData(
                fromDateString: fromDateString,
                toDateString: toDateString,
                promise: promise
            )
        }

        // MARK: - Sync cursor persistence

        Function("getLastSyncTimestamp") { () -> String? in
            let stored = UserDefaults.standard
                .string(forKey: CoreMotionAccountStateStore.lastSyncKey)
                .flatMap(CoreMotionIsoDateParser.parse)
            return self.accountStateStore.effectiveSyncStart(stored)
                .map(CoreMotionIsoDateParser.format)
        }

        Function("setLastSyncTimestamp") { (timestamp: String) in
            self.setLastSyncTimestamp(timestamp)
        }

        AsyncFunction("purgeAccountState") { (cutoffString: String, promise: Promise) in
            self.purgeAccountState(cutoffString: cutoffString, promise: promise)
        }
    }

    private func motionAuthorizationStatus() -> String {
        switch CMMotionActivityManager.authorizationStatus() {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "notDetermined"
        }
    }

    private func requestMotionPermission(promise: Promise) {
        activityManager.queryActivityStarting(
            from: Date().addingTimeInterval(-60),
            to: Date(),
            to: OperationQueue.main
        ) { _, error in
            guard let error else {
                promise.resolve("authorized")
                return
            }
            let nsError = error as NSError
            let denied = nsError.domain == CMErrorDomain &&
                nsError.code == Int(CMErrorMotionActivityNotAuthorized.rawValue)
            promise.resolve(denied ? "denied" : "authorized")
        }
    }

    private func startRecording(durationSeconds: Double, promise: Promise) {
        guard CMSensorRecorder.isAccelerometerRecordingAvailable() else {
            promise.reject(
                "COREMOTION_UNAVAILABLE",
                "Accelerometer recording is not available on this device"
            )
            return
        }
        sensorRecorder.recordAccelerometer(forDuration: min(durationSeconds, 12 * 3600))
        UserDefaults.standard.set(true, forKey: CoreMotionAccountStateStore.recordingActiveKey)
        promise.resolve(true)
    }

    private func queryRecordedData(
        fromDateString: String,
        toDateString: String,
        promise: Promise
    ) {
        guard CMSensorRecorder.isAccelerometerRecordingAvailable() else {
            promise.resolve([])
            return
        }
        guard let requestedFromDate = CoreMotionIsoDateParser.parse(fromDateString),
              let toDate = CoreMotionIsoDateParser.parse(toDateString) else {
            promise.reject("COREMOTION_INVALID_DATE", "Invalid ISO 8601 date string")
            return
        }
        let fromDate = accountStateStore.effectiveSyncStart(requestedFromDate) ?? requestedFromDate
        guard fromDate < toDate else {
            promise.resolve([])
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let samples = self.recordedSamples(from: fromDate, to: toDate)
            DispatchQueue.main.async {
                promise.resolve(samples)
            }
        }
    }

    private func recordedSamples(from fromDate: Date, to toDate: Date) -> [[String: Any]] {
        guard let dataList = sensorRecorder.accelerometerData(from: fromDate, to: toDate) else {
            return []
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var samples: [[String: Any]] = []
        samples.reserveCapacity(50 * 60 * 10)
        for dataPoint in dataList {
            guard let accelerometerData = dataPoint as? CMRecordedAccelerometerData,
                  accountStateStore.shouldInclude(sampleDate: accelerometerData.startDate) else {
                continue
            }
            samples.append([
                "timestamp": formatter.string(from: accelerometerData.startDate),
                "x": accelerometerData.acceleration.x,
                "y": accelerometerData.acceleration.y,
                "z": accelerometerData.acceleration.z,
            ])
        }
        return samples
    }

    private func setLastSyncTimestamp(_ timestamp: String) {
        guard let candidate = CoreMotionIsoDateParser.parse(timestamp),
              let effective = accountStateStore.effectiveSyncStart(candidate) else {
            return
        }
        UserDefaults.standard.set(
            CoreMotionIsoDateParser.format(effective),
            forKey: CoreMotionAccountStateStore.lastSyncKey
        )
    }

    private func purgeAccountState(cutoffString: String, promise: Promise) {
        guard let cutoff = CoreMotionIsoDateParser.parse(cutoffString) else {
            promise.reject(
                "COREMOTION_INVALID_ERASURE_CUTOFF",
                "Invalid device erasure cutoff"
            )
            return
        }
        accountStateStore.purge(at: cutoff)
        promise.resolve(true)
    }
}
#endif
