import Foundation
import UserNotifications

/// App-owned notification lifecycle, serialized on the main queue.
final class CollectionNotificationService {
    private let center: CollectionNotificationCenter
    private let notifications: NotificationCenter
    private let isAppActive: () -> Bool
    private let isCollectionActive: () -> Bool
    private let reportError: (Error, String) -> Void
    private var connectionObserver: NSObjectProtocol?
    private var permissionGeneration: UInt64 = 0
    private var enabled = false
    private var whoopIsConnected = false
    private var requestIdentifiers: [String: String] = [:]
    private lazy var coordinator = CollectionNotificationCoordinator(
        schedule: { [weak self] in self?.schedule($0) },
        cancel: { [weak self] in self?.cancel($0) }
    )

    init(
        center: CollectionNotificationCenter,
        notifications: NotificationCenter,
        isAppActive: @escaping () -> Bool,
        isCollectionActive: @escaping () -> Bool,
        reportError: @escaping (Error, String) -> Void
    ) {
        self.center = center
        self.notifications = notifications
        self.isAppActive = isAppActive
        self.isCollectionActive = isCollectionActive
        self.reportError = reportError
    }

    deinit {
        if let connectionObserver { notifications.removeObserver(connectionObserver) }
    }

    func start() {
        coordinator.appBecameActive()
        connectionObserver = notifications.addObserver(
            forName: Notification.Name("WhoopBle.connectionStateChanged"),
            object: nil,
            queue: nil
        ) { [weak self] notification in
            guard let state = notification.userInfo?["state"] as? String else { return }
            if Thread.isMainThread {
                self?.handleConnectionState(state)
            } else {
                // Main-thread lifecycle snapshots can synchronously query the BLE queue.
                // Its connection publication must never wait for main-thread delivery.
                DispatchQueue.main.async { [weak self] in self?.handleConnectionState(state) }
            }
        }
    }

    private func handleConnectionState(_ state: String) {
        switch state {
        case "connected":
            whoopIsConnected = true
            coordinator.whoopConnected()
        case "disconnected":
            whoopIsConnected = false
            coordinator.whoopDisconnected()
        case "intentionallyDisconnected":
            whoopIsConnected = false
            coordinator.whoopIntentionallyDisconnected()
        default:
            break
        }
    }

    func enable(requestPermission: Bool, completion: @escaping (Result<Bool, Error>) -> Void) {
        permissionGeneration &+= 1
        let generation = permissionGeneration
        center.getAuthorizationStatus { [weak self] status in
            guard let self else { return }
            DispatchQueue.main.async {
                guard generation == self.permissionGeneration else {
                    completion(.success(false))
                    return
                }
                if status == .notDetermined {
                    guard requestPermission, self.isAppActive() else {
                        completion(.success(false))
                        return
                    }
                    self.center.requestAuthorization { granted, error in
                        self.finishAuthorization(
                            granted, error: error, generation: generation, completion: completion
                        )
                    }
                } else {
                    let granted = status == .authorized
                    self.finishAuthorization(
                        granted, error: nil, generation: generation, completion: completion
                    )
                }
            }
        }
    }

    private func finishAuthorization(
        _ granted: Bool,
        error: Error?,
        generation: UInt64,
        completion: @escaping (Result<Bool, Error>) -> Void
    ) {
        DispatchQueue.main.async {
            if let error { self.reportError(error, "authorization") }
            guard generation == self.permissionGeneration else {
                completion(.success(false))
                return
            }
            if let error {
                completion(.failure(error))
                return
            }
            self.enabled = granted
            self.coordinator.setEnabled(granted)
            if granted && self.whoopIsConnected {
                self.coordinator.whoopConnected()
            }
            completion(.success(granted))
        }
    }

    func disable() {
        permissionGeneration &+= 1
        enabled = false
        coordinator.setEnabled(false)
    }

    func appBecameActive() {
        coordinator.appBecameActive()
    }

    /// iOS may omit this callback for a suspended app; never infer termination from inactivity.
    func appWillTerminate() {
        coordinator.appWillTerminate(collectionIsActive: isCollectionActive())
    }

    private func schedule(_ notification: CollectionNotification) {
        // Each save owns its identifier, so a late save cannot overwrite a newer grace period.
        let identifier = "\(notification.identifier).\(UUID().uuidString)"
        if let previous = requestIdentifiers.updateValue(identifier, forKey: notification.identifier) {
            remove([previous])
        }
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: notification.delay, repeats: false)
        )
        center.add(request) { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
                    self.reportError(error, notification.identifier)
                    if self.requestIdentifiers[notification.identifier] == identifier {
                        self.requestIdentifiers.removeValue(forKey: notification.identifier)
                    }
                } else if !self.enabled || self.requestIdentifiers[notification.identifier] != identifier {
                    self.remove([identifier])
                }
            }
        }
    }

    private func cancel(_ identifiers: [String]) {
        let current = identifiers.compactMap { requestIdentifiers.removeValue(forKey: $0) }
        remove(identifiers + current)
        // Find warnings persisted by previous processes. A delayed lookup must preserve any
        // new request scheduled since cancellation, while stale add callbacks remove only themselves.
        let removeCancelled: ([String]) -> Void = { [weak self] savedIdentifiers in
            DispatchQueue.main.async {
                guard let self else { return }
                let active = Set(self.requestIdentifiers.values)
                self.remove(savedIdentifiers.filter { saved in
                    !active.contains(saved) && identifiers.contains {
                        saved == $0 || saved.hasPrefix("\($0).")
                    }
                })
            }
        }
        center.getPendingIdentifiers(completion: removeCancelled)
        center.getDeliveredIdentifiers(completion: removeCancelled)
    }

    private func remove(_ identifiers: [String]) {
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }
}
