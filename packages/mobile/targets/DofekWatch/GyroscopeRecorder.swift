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

    private let sampleBuffer = GyroscopeSampleBuffer()
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
    /// Buffers samples in memory until a successful file transfer confirms them.
    func startRecording() {
        guard Self.isAvailable else { return }
        guard WatchAccountStateStore().isSyncEnabled else { return }
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

            self.sampleBuffer.append(sample)
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

    /// Return a non-destructive snapshot of all buffered gyroscope samples.
    func copyBufferedSamples() -> [[String: Any]] {
        sampleBuffer.snapshot()
    }

    /// Remove the prefix included in a successfully delivered file.
    func confirmTransferredSamples(count: Int) {
        sampleBuffer.confirmTransferredSamples(count: count)
    }

    /// Number of samples currently buffered.
    var bufferedSampleCount: Int {
        sampleBuffer.count
    }

    func purgeAccountState() {
        stopRecording()
        sampleBuffer.clearAll()
    }
}
