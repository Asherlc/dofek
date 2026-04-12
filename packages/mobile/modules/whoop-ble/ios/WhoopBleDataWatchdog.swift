import Foundation

/// Callback when the watchdog detects data silence.
protocol WhoopBleDataWatchdogDelegate: AnyObject {
    func watchdogDidDetectSilence(_ watchdog: WhoopBleDataWatchdog, retryCount: UInt64)
}

/// Monitors for BLE data silence and triggers a callback when no data arrives
/// within the configured timeout. The WHOOP strap sends 0x28 packets at ~1 Hz;
/// sustained silence means our activation commands were likely dropped.
final class WhoopBleDataWatchdog {
    weak var delegate: WhoopBleDataWatchdogDelegate?

    private let queue: DispatchQueue
    private let timeoutSeconds: TimeInterval

    private var lastDataReceivedAt: CFAbsoluteTime = 0
    private var active = false
    private(set) var retryCount: UInt64 = 0
    private var workItem: DispatchWorkItem?

    init(queue: DispatchQueue, timeoutSeconds: TimeInterval = 15) {
        self.queue = queue
        self.timeoutSeconds = timeoutSeconds
    }

    func start() {
        active = true
        lastDataReceivedAt = CFAbsoluteTimeGetCurrent()
        scheduleCheck()
    }

    func stop() {
        active = false
        workItem?.cancel()
        workItem = nil
    }

    /// Call when any BLE data notification is received to reset the silence timer.
    func recordDataReceived() {
        lastDataReceivedAt = CFAbsoluteTimeGetCurrent()
    }

    private func scheduleCheck() {
        workItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.runCheck()
        }
        workItem = item
        queue.asyncAfter(deadline: .now() + timeoutSeconds, execute: item)
    }

    private func runCheck() {
        guard active else { return }

        let silenceSeconds = CFAbsoluteTimeGetCurrent() - lastDataReceivedAt
        if silenceSeconds >= timeoutSeconds {
            retryCount += 1
            NSLog("[WhoopBLE] watchdog: no data for %.0fs, triggering resend (retry #%llu)",
                  silenceSeconds, retryCount)
            delegate?.watchdogDidDetectSilence(self, retryCount: retryCount)
        }

        scheduleCheck()
    }
}
