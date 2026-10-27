import Foundation

/// Restores the active IMU stream after a WHOOP reconnect and publishes the
/// resulting state only once the manager has reached its final lifecycle state.
enum WhoopBleStreamRestorer {
    static func restoreIfNeeded(
        wasStreaming: Bool,
        startStreaming: () -> Bool,
        activateImu: () -> Void,
        emitDeviceState: () -> Void
    ) {
        guard wasStreaming else { return }

        activateImu()
        guard startStreaming() else { return }
        emitDeviceState()
    }
}
