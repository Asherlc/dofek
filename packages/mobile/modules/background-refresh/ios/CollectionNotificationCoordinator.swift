import Foundation

enum CollectionNotification: Equatable {
    case whoopDisconnected
    case appClosed

    var identifier: String {
        switch self {
        case .whoopDisconnected:
            return "com.dofek.collection.whoop-disconnected"
        case .appClosed:
            return "com.dofek.collection.app-closed"
        }
    }

    var title: String {
        switch self {
        case .whoopDisconnected:
            return "WHOOP disconnected"
        case .appClosed:
            return "Dofek closed"
        }
    }

    var body: String {
        switch self {
        case .whoopDisconnected:
            return "Dofek lost its connection to your WHOOP. Open Dofek and keep your WHOOP nearby to resume collecting data."
        case .appClosed:
            return "Background data collection may stop while Dofek is closed. Open Dofek to keep collecting data."
        }
    }

    var delay: TimeInterval {
        switch self {
        case .whoopDisconnected:
            return 300
        case .appClosed:
            return 1
        }
    }
}

/// Owns notification policy; callers serialize lifecycle and BLE events.
final class CollectionNotificationCoordinator {
    private let schedule: (CollectionNotification) -> Void
    private let cancel: ([String]) -> Void
    private var enabled = false
    private var whoopIsConnected = false

    init(
        schedule: @escaping (CollectionNotification) -> Void,
        cancel: @escaping ([String]) -> Void
    ) {
        self.schedule = schedule
        self.cancel = cancel
    }

    func setEnabled(_ enabled: Bool) {
        self.enabled = enabled
        if !enabled {
            whoopIsConnected = false
            cancel([
                CollectionNotification.whoopDisconnected.identifier,
                CollectionNotification.appClosed.identifier,
            ])
        }
    }

    func whoopConnected() {
        guard enabled else { return }
        whoopIsConnected = true
        cancel([CollectionNotification.whoopDisconnected.identifier])
    }

    func whoopDisconnected() {
        guard enabled, whoopIsConnected else { return }
        whoopIsConnected = false
        schedule(.whoopDisconnected)
    }

    func whoopIntentionallyDisconnected() {
        whoopIsConnected = false
        cancel([CollectionNotification.whoopDisconnected.identifier])
    }

    func appBecameActive() {
        cancel([CollectionNotification.appClosed.identifier])
    }

    func appWillTerminate() {
        guard enabled else { return }
        schedule(.appClosed)
    }
}
