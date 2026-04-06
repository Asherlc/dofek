import CoreMotion
import Foundation

/// Records gyroscope data on Apple Watch using CMMotionManager.
/// Unlike CMSensorRecorder (accelerometer-only, background-capable),
/// CMMotionManager requires an active session — gyroscope recording
/// only runs while the Watch app is in the foreground.
final class GyroscopeRecorder: ObservableObject {
    static let shared = GyroscopeRecorder()

    private let motionManager = CMMotionManager()
    private let operationQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "com.dofek.watch.gyroscope"
        queue.maxConcurrentOperationCount = 1
        return queue
    }()

    private var buffer: [[String: Any]] = []
    private let bufferLock = NSLock()
    private let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let samplingIntervalSeconds: TimeInterval = 1.0 / 50.0 // 50 Hz

    @Published var isRecording: Bool = false

    static var isAvailable: Bool {
        CMMotionManager().isDeviceMotionAvailable
    }

    /// Start recording gyroscope data at 50 Hz.
    /// Buffers samples in memory until `queryNewSamples()` is called.
    func startRecording() {
        guard Self.isAvailable else { return }
        guard !motionManager.isDeviceMotionActive else { return }

        motionManager.deviceMotionUpdateInterval = Self.samplingIntervalSeconds

        motionManager.startDeviceMotionUpdates(to: operationQueue) { [weak self] motion, error in
            guard let self = self, let motion = motion, error == nil else { return }

            let sample: [String: Any] = [
                "timestamp": self.formatter.string(from: Date()),
                "gyroscopeX": motion.rotationRate.x,
                "gyroscopeY": motion.rotationRate.y,
                "gyroscopeZ": motion.rotationRate.z,
            ]

            self.bufferLock.lock()
            self.buffer.append(sample)
            self.bufferLock.unlock()
        }

        DispatchQueue.main.async {
            self.isRecording = true
        }
    }

    /// Stop recording gyroscope data.
    func stopRecording() {
        motionManager.stopDeviceMotionUpdates()
        DispatchQueue.main.async {
            self.isRecording = false
        }
    }

    /// Drain the buffer and return all recorded gyroscope samples.
    /// After calling this, the internal buffer is empty.
    func queryNewSamples() -> [[String: Any]] {
        bufferLock.lock()
        let samples = buffer
        buffer = []
        bufferLock.unlock()
        return samples
    }

    /// Number of samples currently buffered.
    var bufferedSampleCount: Int {
        bufferLock.lock()
        let count = buffer.count
        bufferLock.unlock()
        return count
    }
}
