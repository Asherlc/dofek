#if canImport(Sentry)
import Sentry
#endif
import CoreMotion
import Foundation

/// Records barometric altitude on Apple Watch using CMAltimeter.
///
/// Unlike CMSensorRecorder (accelerometer-only, background-capable), CMAltimeter
/// requires an active session — altitude recording only runs while the Watch app
/// is in the foreground.
final class AltimeterRecorder: ObservableObject {
    static let shared = AltimeterRecorder()

    private let altimeter = CMAltimeter()
    private let callbackFence = WatchRecordingCallbackFence()
    private let accountStateStore = WatchAccountStateStore()
    private let operationQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "com.dofek.watch.altimeter"
        queue.maxConcurrentOperationCount = 1
        return queue
    }()

    private var buffer: [[String: Any]] = []
    private var baselinePressureKPa: Double?
    private let bufferLock = NSLock()
    private let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    @Published private(set) var recordingStartedAt: Date?
    @Published private(set) var bufferedSampleCount: Int = 0
    @Published private(set) var lastError: String?

    var isRecording: Bool { recordingStartedAt != nil }

    static var isAvailable: Bool {
        CMAltimeter.isRelativeAltitudeAvailable()
    }

    /// Start recording barometric altitude samples (~1 Hz).
    /// Buffers samples in memory until `clearBufferedSamples(count:)` is called after transfer.
    func startRecording() {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { self.startRecording() }
            return
        }
        guard Self.isAvailable else {
            publishError("Barometer not available on this device")
            return
        }
        guard accountStateStore.isSyncEnabled else { return }
        guard !isRecording else { return }

        let identity = callbackFence.reset()
        altimeter.startRelativeAltitudeUpdates(to: operationQueue) { [weak self] data, error in
            guard let self = self else { return }
            if let error = error {
                NSLog("[AltimeterRecorder] update error: %@", error.localizedDescription)
                #if canImport(Sentry)
                SentrySDK.capture(error: error)
                #endif
                self.callbackFence.whenCurrentOnMain(identity) {
                    self.publishError(error.localizedDescription)
                }
                return
            }
            guard let data = data else { return }

            let pressureKPa = data.pressure.doubleValue

            var appended = false
            self.callbackFence.apply(ifCurrent: identity) {
                self.bufferLock.lock()
                defer { self.bufferLock.unlock() }
                guard self.accountStateStore.isSyncEnabled else { return }
                if self.baselinePressureKPa == nil {
                    self.baselinePressureKPa = pressureKPa
                }
                let baseline = self.baselinePressureKPa ?? pressureKPa
                let altitudeM = AltitudeCalculator.relativeAltitudeMeters(
                    pressureKPa: pressureKPa,
                    baselinePressureKPa: baseline
                )
                let sample: [String: Any] = [
                    "timestamp": self.formatter.string(from: Date()),
                    "altitudeM": altitudeM,
                    "pressureKPa": pressureKPa,
                ]
                self.buffer.append(sample)
                appended = true
            }
            if appended { self.publishBufferedSampleCount() }
        }

        recordingStartedAt = Date()
        lastError = nil
        WatchSessionDelegate.shared.publishRecordingActivity()
    }

    /// Stop recording barometric altitude samples.
    func stopRecording() {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { self.stopRecording() }
            return
        }
        callbackFence.reset()
        altimeter.stopRelativeAltitudeUpdates()
        recordingStartedAt = nil
        WatchSessionDelegate.shared.publishRecordingActivity()
    }

    /// Snapshot buffered samples without draining.
    /// Call `clearBufferedSamples(count:)` after WCSession confirms delivery.
    func copyBufferedSamples() -> [[String: Any]] {
        bufferLock.lock()
        let samples = buffer
        bufferLock.unlock()
        return samples
    }

    /// Remove transferred samples while preserving any newer in-flight entries.
    /// Resets the session baseline only when the buffer is fully drained.
    func clearBufferedSamples(count: Int) {
        bufferLock.lock()
        if count >= buffer.count {
            buffer.removeAll()
            baselinePressureKPa = nil
        } else if count > 0 {
            buffer.removeFirst(count)
        }
        bufferLock.unlock()
        publishBufferedSampleCount()
    }

    func purgeAccountState() {
        let identity = callbackFence.reset {
            bufferLock.lock()
            buffer.removeAll()
            baselinePressureKPa = nil
            bufferLock.unlock()
        }
        callbackFence.whenCurrentOnMain(identity) { self.stopRecording() }
        publishBufferedSampleCount()
    }

    private func publishBufferedSampleCount() {
        DispatchQueue.main.async {
            self.bufferLock.lock()
            let count = self.buffer.count
            self.bufferLock.unlock()
            self.bufferedSampleCount = count
        }
    }

    private func publishError(_ message: String) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { self.publishError(message) }
            return
        }
        callbackFence.reset()
        altimeter.stopRelativeAltitudeUpdates()
        lastError = message
        recordingStartedAt = nil
        WatchSessionDelegate.shared.publishRecordingActivity()
    }
}
