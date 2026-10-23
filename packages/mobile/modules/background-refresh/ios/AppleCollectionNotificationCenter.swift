#if os(iOS)
import RNSentry
import UIKit
import UserNotifications

extension CollectionNotificationService {
    static let shared = CollectionNotificationService(
        center: AppleCollectionNotificationCenter(),
        notifications: .default,
        isAppActive: { UIApplication.shared.applicationState == .active },
        isCollectionActive: { NativeCollectionActivity.isActive() },
        reportError: { error, identifier in
            SentrySDK.capture(error: error) { scope in
                scope.setTag(value: identifier, key: "collection_notification")
            }
        }
    )
}

/// Keeps Apple notification delivery and foreground presentation in the iOS adapter.
private final class AppleCollectionNotificationCenter: NSObject,
    CollectionNotificationCenter, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()

    override init() {
        super.init()
        center.delegate = self
    }

    func getAuthorizationStatus(completion: @escaping (CollectionNotificationAuthorizationStatus) -> Void) {
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .notDetermined:
                completion(.notDetermined)
            case .authorized, .provisional, .ephemeral:
                completion(.authorized)
            default:
                completion(.denied)
            }
        }
    }

    func requestAuthorization(completion: @escaping (Bool, Error?) -> Void) {
        center.requestAuthorization(options: [.alert, .sound], completionHandler: completion)
    }

    func add(_ request: UNNotificationRequest, completion: @escaping (Error?) -> Void) {
        center.add(request, withCompletionHandler: completion)
    }

    func getPendingIdentifiers(completion: @escaping ([String]) -> Void) {
        center.getPendingNotificationRequests { completion($0.map(\.identifier)) }
    }

    func getDeliveredIdentifiers(completion: @escaping ([String]) -> Void) {
        center.getDeliveredNotifications { completion($0.map { $0.request.identifier }) }
    }

    func removePendingNotificationRequests(withIdentifiers identifiers: [String]) {
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
    }

    func removeDeliveredNotifications(withIdentifiers identifiers: [String]) {
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
