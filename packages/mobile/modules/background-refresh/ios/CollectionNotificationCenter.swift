import UserNotifications

enum CollectionNotificationAuthorizationStatus {
    case notDetermined
    case denied
    case authorized
}

/// Notification delivery boundary; callbacks may arrive on any queue.
protocol CollectionNotificationCenter {
    func getAuthorizationStatus(completion: @escaping (CollectionNotificationAuthorizationStatus) -> Void)
    func requestAuthorization(completion: @escaping (Bool, Error?) -> Void)
    func add(_ request: UNNotificationRequest, completion: @escaping (Error?) -> Void)
    func getPendingIdentifiers(completion: @escaping ([String]) -> Void)
    func getDeliveredIdentifiers(completion: @escaping ([String]) -> Void)
    func removePendingNotificationRequests(withIdentifiers identifiers: [String])
    func removeDeliveredNotifications(withIdentifiers identifiers: [String])
}
