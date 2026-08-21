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

    @Published var isRecording: Bool = false
    @Published private(set) var bufferedSampleCount: Int = 0
    @Published private(set) var lastError: String?

    static var isAvailable: Bool {
        CMAltimeter.isRelativeAltitudeAvailable()
    }

    /// Start recording barometric altitude samples (~1 Hz).
    /// Buffers samples in memory until `clearBufferedSamples(count:)` is called after transfer.
    func startRecording() {
        guard Self.isAvailable else {
            publishError("Barometer not available on this device")
            return
        }
        guard accountStateStore.isSyncEnabled else { return }
        guard !isRecording else { return }

        altimeter.startRelativeAltitudeUpdates(to: operationQueue) { [weak self] data, error in
            guard let self = self else { return }
            if let error = error {
                NSLog("[AltimeterRecorder] update error: %@", error.localizedDescription)
                self.publishError(error.localizedDescription)
                return
            }
            guard let data = data else { return }

            let pressureKPa = data.pressure.doubleValue

            self.bufferLock.lock()
            guard self.accountStateStore.isSyncEnabled else {
                self.bufferLock.unlock()
                return
            }
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
            let count = self.buffer.count
            self.bufferLock.unlock()
            self.publishBufferedSampleCount(count)
        }

        DispatchQueue.main.async {
            self.isRecording = true
            self.lastError = nil
        }
    }

    /// Stop recording barometric altitude samples.
    func stopRecording() {
        altimeter.stopRelativeAltitudeUpdates()
        DispatchQueue.main.async {
            self.isRecording = false
        }
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
        let remaining = buffer.count
        bufferLock.unlock()
        publishBufferedSampleCount(remaining)
    }

    func purgeAccountState() {
        stopRecording()
        bufferLock.lock()
        buffer.removeAll()
        baselinePressureKPa = nil
        bufferLock.unlock()
        publishBufferedSampleCount(0)
    }

    private func publishBufferedSampleCount(_ count: Int) {
        DispatchQueue.main.async {
            self.bufferedSampleCount = count
        }
    }

    private func publishError(_ message: String) {
        altimeter.stopRelativeAltitudeUpdates()
        DispatchQueue.main.async {
            self.lastError = message
            self.isRecording = false
        }
    }
}
