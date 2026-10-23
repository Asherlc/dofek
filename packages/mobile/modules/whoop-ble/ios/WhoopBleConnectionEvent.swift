import Foundation

enum WhoopBleConnectionEvent: String {
    case connected
    case disconnected
    case intentionallyDisconnected

    static let name = Notification.Name("WhoopBle.connectionStateChanged")

    func post() {
        NotificationCenter.default.post(
            name: Self.name,
            object: nil,
            userInfo: ["state": rawValue]
        )
    }
}
