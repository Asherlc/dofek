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

    static var isAvailable: Bool {
        CMAltimeter.isRelativeAltitudeAvailable()
    }

    /// Start recording barometric altitude samples (~1 Hz).
    /// Buffers samples in memory until `clearBufferedSamples()` is called after transfer.
    func startRecording() {
        guard Self.isAvailable else { return }
        guard !isRecording else { return }

        bufferLock.lock()
        baselinePressureKPa = nil
        bufferLock.unlock()

        altimeter.startRelativeAltitudeUpdates(to: operationQueue) { [weak self] data, error in
            guard let self = self else { return }
            if let error = error {
                NSLog("[AltimeterRecorder] update error: %@", error.localizedDescription)
                return
            }
            guard let data = data else { return }

            let pressureKPa = data.pressure.doubleValue

            self.bufferLock.lock()
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
            self.bufferLock.unlock()
        }

        DispatchQueue.main.async {
            self.isRecording = true
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
    /// Use `clearBufferedSamples()` after a successful transfer.
    func copyBufferedSamples() -> [[String: Any]] {
        bufferLock.lock()
        let samples = buffer
        bufferLock.unlock()
        return samples
    }

    /// Drain the buffer and reset the baseline after a successful transfer.
    func clearBufferedSamples() {
        bufferLock.lock()
        buffer = []
        baselinePressureKPa = nil
        bufferLock.unlock()
    }

    /// Number of samples currently buffered.
    var bufferedSampleCount: Int {
        bufferLock.lock()
        let count = buffer.count
        bufferLock.unlock()
        return count
    }
}
