#if os(iOS)
import RNSentry
import UIKit
import UserNotifications

/// App-owned notification delivery, serialized on the main queue.
final class CollectionNotificationService: NSObject, UNUserNotificationCenterDelegate {
    static let shared = CollectionNotificationService()

    private let center = UNUserNotificationCenter.current()
    private var connectionObserver: NSObjectProtocol?
    private var permissionGeneration: UInt64 = 0
    private var enabled = false
    private var whoopIsConnected = false
    private var cancelledIdentifiers: Set<String> = []
    private lazy var coordinator = CollectionNotificationCoordinator(
        schedule: { [weak self] in self?.schedule($0) },
        cancel: { [weak self] in self?.cancel($0) }
    )

    func start() {
        center.delegate = self
        coordinator.appBecameActive()
        connectionObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("WhoopBle.connectionStateChanged"),
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self, let state = notification.userInfo?["state"] as? String else { return }
            switch state {
            case "connected":
                self.whoopIsConnected = true
                self.coordinator.whoopConnected()
            case "disconnected":
                self.whoopIsConnected = false
                self.coordinator.whoopDisconnected()
            case "intentionallyDisconnected":
                self.whoopIsConnected = false
                self.coordinator.whoopIntentionallyDisconnected()
            default:
                break
            }
        }
    }

    func enable(requestPermission: Bool, completion: @escaping (Result<Bool, Error>) -> Void) {
        permissionGeneration &+= 1
        let generation = permissionGeneration
        center.getNotificationSettings { [weak self] settings in
            guard let self else { return }
            DispatchQueue.main.async {
                guard generation == self.permissionGeneration else {
                    completion(.success(false))
                    return
                }
                if settings.authorizationStatus == .notDetermined {
                    guard requestPermission, UIApplication.shared.applicationState == .active else {
                        completion(.success(false))
                        return
                    }
                    self.center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                        self.finishAuthorization(
                            granted, error: error, generation: generation, completion: completion
                        )
                    }
                } else {
                    let granted = settings.authorizationStatus == .authorized
                        || settings.authorizationStatus == .provisional
                        || settings.authorizationStatus == .ephemeral
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
        coordinator.appWillTerminate()
    }

    private func schedule(_ notification: CollectionNotification) {
        cancelledIdentifiers.remove(notification.identifier)
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: notification.identifier,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: notification.delay, repeats: false)
        )
        center.add(request) { [weak self] error in
            if let error {
                SentrySDK.capture(error: error) { scope in
                    scope.setTag(value: notification.identifier, key: "collection_notification")
                }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                // A reconnect or sign-out can cancel while the system persists the request.
                if !self.enabled || self.cancelledIdentifiers.contains(notification.identifier) {
                    self.cancel([notification.identifier])
                }
            }
        }
    }

    private func cancel(_ identifiers: [String]) {
        cancelledIdentifiers.formUnion(identifiers)
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
#endif
