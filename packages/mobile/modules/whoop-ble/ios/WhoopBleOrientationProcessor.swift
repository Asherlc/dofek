import Foundation

/// Feeds IMU samples through a Madgwick AHRS filter and emits throttled
/// orientation events (~30 Hz from 100 Hz input).
final class WhoopBleOrientationProcessor {
    private let filter: MadgwickFilter
    private var sampleCounter: Int = 0
    private let emitInterval: Int

    init(sampleRate: Double = 100, beta: Double = 0.1, emitInterval: Int = 3) {
        self.filter = MadgwickFilter(sampleRate: sampleRate, beta: beta)
        self.emitInterval = emitInterval
    }

    func reset() {
        filter.reset()
        sampleCounter = 0
    }

    /// Process IMU samples and call `onOrientation` every `emitInterval` samples.
    func processSamples(
        _ samples: [WhoopImuSample],
        onOrientation: (Quaternion, EulerAngles) -> Void
    ) {
        for sample in samples {
            filter.update(
                accelerometerX: sample.accelerometerX,
                accelerometerY: sample.accelerometerY,
                accelerometerZ: sample.accelerometerZ,
                gyroscopeX: sample.gyroscopeX,
                gyroscopeY: sample.gyroscopeY,
                gyroscopeZ: sample.gyroscopeZ
            )

            sampleCounter += 1
            if sampleCounter >= emitInterval {
                sampleCounter = 0
                onOrientation(filter.quaternion, filter.eulerAngles)
            }
        }
    }
}
