import Foundation

/// Core-Bluetooth-independent lifecycle state for one heart-rate monitor.
final class BleHeartRatePeripheralSession {
    let id: String
    var state: BleHeartRateConnectionState

    init(id: String, state: BleHeartRateConnectionState = .idle) {
        self.id = id
        self.state = state
    }

    func markDisconnected() {
        state = .idle
    }

    func markTimedOut() {
        state = .idle
    }
}
